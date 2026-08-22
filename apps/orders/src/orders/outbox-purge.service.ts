import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { OutboxRepository } from './outbox.repository';
import { getOutboxConfig, OutboxConfig } from './outbox.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cierra el gap documentado que deja el diseño del outbox: de lo contrario,
 * `outbox_events` crece para siempre. Barrido diario de las filas `sent` que
 * superan la ventana de retención — las filas `pending`/`failed` nunca se
 * tocan, quedan disponibles para inspección.
 */
@Injectable()
export class OutboxPurgeService {
  private readonly config: OutboxConfig;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    @InjectPinoLogger(OutboxPurgeService.name)
    private readonly logger: PinoLogger,
  ) {
    this.config = getOutboxConfig();
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purge(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.config.purgeRetentionDays * MS_PER_DAY,
    );

    const deleted = await this.outboxRepository.deleteSentOlderThan(cutoff);

    if (deleted > 0) {
      this.logger.info(
        { deleted, retentionDays: this.config.purgeRetentionDays },
        'Purged sent outbox events past retention window',
      );
    }
  }
}
