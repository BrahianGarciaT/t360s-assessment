import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { AUDIT_TCP_CLIENT } from './orders.constants';
import { OutboxRepository } from './outbox.repository';
import { getOutboxConfig, OutboxConfig } from './outbox.constants';

// Read once at module load — @Interval requires a static value, and env vars
// are already available at process startup (no ConfigService/DI needed here).
const POLL_INTERVAL_MS = getOutboxConfig().pollIntervalMs;

@Injectable()
export class OutboxPollerService {
  private readonly logger = new Logger(OutboxPollerService.name);
  private readonly config: OutboxConfig;
  private running = false;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    @Inject(AUDIT_TCP_CLIENT) private readonly auditClient: ClientProxy,
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
            `Failed to deliver outbox event ${row.id} (attempt ${row.attempts})`,
            error instanceof Error ? error.stack : String(error),
          );
          // Force a fresh socket next tick — ClientTCP reconnection after the
          // peer disappears is historically unreliable.
          this.auditClient.close();
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
