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

// Read once at module load — @Interval requires a static value, and env vars
// are already available at process startup (no ConfigService/DI needed here).
const POLL_INTERVAL_MS = getOutboxConfig().pollIntervalMs;

/**
 * Maps an outbox `eventType` to the TCP `@MessagePattern` `inventory`
 * actually listens on. `order.*` events reuse the eventType verbatim as the
 * pattern (audit's `@MessagePattern(ORDER_EVENTS.STATUS_CHANGED)` matches
 * the stored eventType 1:1) — inventory's finalize/release patterns
 * (`inventory.commit` / `inventory.release`) intentionally differ from the
 * outbox eventType names (`inventory.commit_requested` /
 * `inventory.release_requested`, which describe what was *requested*, not
 * the RPC being invoked), so this translation table is required.
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
   * Routes an outbox row to its destination by `eventType` prefix
   * (`order.*` → audit, `inventory.*` → inventory). Returns `null` for an
   * unroutable eventType — the caller MUST `markError`, never guess a
   * client (threat matrix: a malformed row must never be misdelivered).
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
   * Drains due outbox events oldest-first. `@Interval` does not skip
   * overlapping ticks by itself, hence the in-memory re-entrancy guard.
   */
  @Interval(POLL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const rows = await this.outboxRepository.claimDue(this.config.batchSize);
      // Per-destination failure isolation (design decision #8): a down peer
      // stops hammering ITS rows for the rest of this tick, but never stalls
      // delivery to a different, healthy destination.
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
    // Bump attempts/backoff BEFORE emitting: a crash mid-send reschedules
    // instead of hot-looping the same failing row forever.
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

      // Force a fresh socket next tick, on the FAILED destination's client
      // only (design open question, resolved). Verified (not assumed): once
      // the peer disappears, ClientTCP.connect() otherwise keeps returning
      // the same stale rejected connectionPromise forever and never
      // attempts a new socket — reconnection never recovers, even after the
      // peer is reachable again — unless something resets its internal
      // state. `close()` does that reset.
      //
      // Never let a failure here escape tick(): `@Interval` only wraps the
      // awaited method call in try/catch, not a stray synchronous throw
      // from close() itself (or anything it triggers outside that call
      // stack). An uncaught rejection anywhere in the process is fatal by
      // default on Node >=15, so this must never propagate.
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
