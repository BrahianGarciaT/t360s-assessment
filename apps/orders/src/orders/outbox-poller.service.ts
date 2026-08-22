import { Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom, timeout } from 'rxjs';
import { INVENTORY_EVENTS, INVENTORY_PATTERNS } from '@app/shared';
import { AUDIT_TCP_CLIENT, INVENTORY_TCP_CLIENT } from './orders.constants';
import { OutboxRepository } from './outbox.repository';
import { getOutboxConfig, OutboxConfig } from './outbox.constants';
import { OutboxEvent } from './entities/outbox-event.entity';

// Se lee una sola vez al cargar el módulo — @Interval requiere un valor
// estático, y las env vars ya están disponibles al iniciar el proceso (no se
// necesita ConfigService/DI aquí).
const POLL_INTERVAL_MS = getOutboxConfig().pollIntervalMs;

/**
 * Mapea un `eventType` de outbox al `@MessagePattern` TCP que `inventory`
 * realmente escucha. Los eventos `order.*` reutilizan el eventType tal cual
 * como pattern (el `@MessagePattern(ORDER_EVENTS.STATUS_CHANGED)` de audit
 * coincide 1:1 con el eventType almacenado) — los patterns de
 * finalize/release de inventory (`inventory.commit` / `inventory.release`)
 * difieren intencionalmente de los nombres de eventType del outbox
 * (`inventory.commit_requested` / `inventory.release_requested`, que
 * describen lo que se *solicitó*, no el RPC que se invoca), por lo que esta
 * tabla de traducción es necesaria.
 */
const INVENTORY_EVENT_TYPE_TO_PATTERN: Record<string, string> = {
  [INVENTORY_EVENTS.COMMIT_REQUESTED]: INVENTORY_PATTERNS.COMMIT,
  [INVENTORY_EVENTS.RELEASE_REQUESTED]: INVENTORY_PATTERNS.RELEASE,
};

interface OutboxDestination {
  name: string;
  client: ClientProxy;
  resolvePattern: (eventType: string) => string;
}

@Injectable()
export class OutboxPollerService {
  private readonly config: OutboxConfig;
  private running = false;
  private readonly destinations: OutboxDestination[];

  constructor(
    private readonly outboxRepository: OutboxRepository,
    @Inject(AUDIT_TCP_CLIENT) private readonly auditClient: ClientProxy,
    @Inject(INVENTORY_TCP_CLIENT) private readonly inventoryClient: ClientProxy,
    @InjectPinoLogger(OutboxPollerService.name)
    private readonly logger: PinoLogger,
  ) {
    this.config = getOutboxConfig();
    this.destinations = [
      {
        name: 'audit',
        client: this.auditClient,
        resolvePattern: (eventType) => eventType,
      },
      {
        name: 'inventory',
        client: this.inventoryClient,
        resolvePattern: (eventType) =>
          INVENTORY_EVENT_TYPE_TO_PATTERN[eventType] ?? eventType,
      },
    ];
  }

  /**
   * Enruta una fila de outbox a su destino según el prefijo del `eventType`
   * (`order.*` → audit, `inventory.*` → inventory). Devuelve `null` para un
   * eventType no enrutable — el caller DEBE llamar a `markError`, nunca
   * adivinar un client (matriz de amenazas: una fila malformada nunca debe
   * entregarse al destino equivocado).
   */
  private resolveDestination(eventType: string): OutboxDestination | null {
    if (eventType.startsWith('order.')) {
      return this.destinations[0];
    }
    if (eventType.startsWith('inventory.')) {
      return this.destinations[1];
    }
    return null;
  }

  /**
   * Drena los eventos de outbox vencidos en orden del más antiguo al más
   * reciente. `@Interval` no salta ticks superpuestos por sí solo, de ahí el
   * guard de re-entrancy en memoria.
   */
  @Interval(POLL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const rows = await this.outboxRepository.claimDue(this.config.batchSize);
      // Aislamiento de fallas por destino (decisión de diseño #8): un peer
      // caído deja de martillar SUS filas por el resto de este tick, pero
      // nunca bloquea la entrega a otro destino sano.
      const failedDestinations = new Set<string>();

      for (const row of rows) {
        const destination = this.resolveDestination(row.eventType);

        if (!destination) {
          await this.markUnroutable(row);
          continue;
        }

        if (failedDestinations.has(destination.name)) {
          continue;
        }

        await this.deliver(row, destination, failedDestinations);
      }
    } finally {
      this.running = false;
    }
  }

  private async markUnroutable(row: OutboxEvent): Promise<void> {
    await this.outboxRepository.markAttempt(
      row,
      this.config.backoffBaseMs,
      this.config.backoffMaxMs,
    );
    const error = new Error(`Unroutable outbox eventType: ${row.eventType}`);
    await this.outboxRepository.markError(
      row.id,
      row.attempts,
      this.config.maxAttempts,
      error,
    );
    this.logger.error(
      { eventId: row.id, eventType: row.eventType },
      'Unroutable outbox eventType — no destination client matched',
    );
  }

  private async deliver(
    row: OutboxEvent,
    destination: OutboxDestination,
    failedDestinations: Set<string>,
  ): Promise<void> {
    // Incrementa attempts/backoff ANTES de emitir: un crash a mitad del envío
    // reprograma en vez de hacer hot-looping para siempre sobre la misma
    // fila fallida.
    await this.outboxRepository.markAttempt(
      row,
      this.config.backoffBaseMs,
      this.config.backoffMaxMs,
    );

    try {
      await firstValueFrom(
        destination.client
          .send(destination.resolvePattern(row.eventType), {
            eventId: row.id,
            ...row.payload,
          })
          .pipe(timeout(this.config.sendTimeoutMs)),
      );
      await this.outboxRepository.markSent(row.id);
    } catch (error) {
      await this.outboxRepository.markError(
        row.id,
        row.attempts,
        this.config.maxAttempts,
        error,
      );
      this.logger.error(
        {
          eventId: row.id,
          destination: destination.name,
          attempt: row.attempts,
          correlationId: extractCorrelationId(row.payload),
          err: error instanceof Error ? error.stack : String(error),
        },
        'Failed to deliver outbox event',
      );
      failedDestinations.add(destination.name);

      // Fuerza un socket nuevo en el próximo tick, solo en el client del
      // destino que FALLÓ (pregunta abierta de diseño, resuelta). Verificado
      // (no asumido): una vez que el peer desaparece, ClientTCP.connect() de
      // lo contrario sigue devolviendo para siempre la misma
      // connectionPromise obsoleta y rechazada, y nunca intenta un socket
      // nuevo — la reconexión nunca se recupera, incluso después de que el
      // peer vuelve a estar disponible — a menos que algo resetee su estado
      // interno. `close()` hace ese reset.
      //
      // Nunca dejes que una falla acá escape de tick(): `@Interval` solo
      // envuelve en try/catch la llamada awaited al método, no un throw
      // síncrono suelto proveniente del propio close() (o de cualquier cosa
      // que dispare fuera de ese call stack). Un rechazo no capturado en
      // cualquier parte del proceso es fatal por defecto en Node >=15, así
      // que esto nunca debe propagarse.
      try {
        destination.client.close();
      } catch (closeError) {
        this.logger.error(
          {
            eventId: row.id,
            destination: destination.name,
            err:
              closeError instanceof Error
                ? closeError.stack
                : String(closeError),
          },
          'destination client.close() threw while recovering from a delivery failure',
        );
      }
    }
  }
}

function extractCorrelationId(
  payload: Record<string, unknown>,
): string | undefined {
  const metadata = payload.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return undefined;
  }
  const correlationId = (metadata as Record<string, unknown>).correlationId;
  return typeof correlationId === 'string' ? correlationId : undefined;
}
