import { Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom, timeout } from 'rxjs';
import { AUDIT_TCP_CLIENT } from './orders.constants';
import { OutboxRepository } from './outbox.repository';
import { getOutboxConfig, OutboxConfig } from './outbox.constants';

// Read once at module load — @Interval requires a static value, and env vars
// are already available at process startup (no ConfigService/DI needed here).
const POLL_INTERVAL_MS = getOutboxConfig().pollIntervalMs;

@Injectable()
export class OutboxPollerService {
  private readonly config: OutboxConfig;
  private running = false;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    @Inject(AUDIT_TCP_CLIENT) private readonly auditClient: ClientProxy,
    @InjectPinoLogger(OutboxPollerService.name)
    private readonly logger: PinoLogger,
  ) {
    this.config = getOutboxConfig();
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

      for (const row of rows) {
        // Bump attempts/backoff BEFORE emitting: a crash mid-send reschedules
        // instead of hot-looping the same failing row forever.
        await this.outboxRepository.markAttempt(
          row,
          this.config.backoffBaseMs,
          this.config.backoffMaxMs,
        );

        try {
          await firstValueFrom(
            this.auditClient
              .send(row.eventType, { eventId: row.id, ...row.payload })
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
              attempt: row.attempts,
              correlationId: extractCorrelationId(row.payload),
              err: error instanceof Error ? error.stack : String(error),
            },
            'Failed to deliver outbox event',
          );
          // Force a fresh socket next tick. Verified (not assumed): once the
          // peer disappears, ClientTCP.connect() otherwise keeps returning
          // the same stale rejected connectionPromise forever and never
          // attempts a new socket — reconnection never recovers, even after
          // the peer is reachable again — unless something resets its
          // internal state. `close()` does that reset.
          //
          // Never let a failure here escape tick(): `@Interval` only wraps
          // the awaited method call in try/catch, not a stray synchronous
          // throw from close() itself (or anything it triggers outside that
          // call stack). An uncaught rejection anywhere in the process is
          // fatal by default on Node >=15, so this must never propagate.
          try {
            this.auditClient.close();
          } catch (closeError) {
            this.logger.error(
              {
                eventId: row.id,
                err:
                  closeError instanceof Error
                    ? closeError.stack
                    : String(closeError),
              },
              'auditClient.close() threw while recovering from a delivery failure',
            );
          }
          break;
        }
      }
    } finally {
      this.running = false;
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
