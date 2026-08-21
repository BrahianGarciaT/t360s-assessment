import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InventoryRepository } from './inventory.repository';
import { getInventoryConfig, InventoryConfig } from './inventory.constants';

/**
 * Compensation safety net for the reserve→commit/cancel window: releases
 * `held` reservations that never reached a terminal state before their
 * TTL, returning the reserved quantity to available stock. Mirrors
 * `OutboxPurgeService`'s idiom (config clone + `@Cron`).
 */
@Injectable()
export class ReservationReaperService {
  private readonly config: InventoryConfig;

  constructor(
    private readonly inventoryRepository: InventoryRepository,
    @InjectPinoLogger(ReservationReaperService.name)
    private readonly logger: PinoLogger,
  ) {
    this.config = getInventoryConfig();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reap(): Promise<void> {
    const expired = await this.inventoryRepository.claimExpired(
      this.config.reapBatchSize,
    );

    for (const reservation of expired) {
      await this.inventoryRepository.finalize(
        reservation.orderId,
        'release',
        'expired',
      );
    }

    if (expired.length > 0) {
      this.logger.info(
        { count: expired.length },
        'Released expired reservations past their TTL',
      );
    }
  }
}
