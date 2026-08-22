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
      // The reaper is an internal @Cron trigger, not a redelivered outbox
      // event, so there is no real `eventId` to forward. Synthesize one so
      // this call satisfies finalize()'s eventId-keyed dedup contract the
      // same way a real event would — deterministic and unique per
      // reservation, since claimExpired only ever returns a HELD reservation
      // once (it stops matching the HELD filter as soon as it is released).
      try {
        await this.inventoryRepository.finalize(
          reservation.orderId,
          'release',
          `internal:reaper:${reservation.orderId}`,
          'expired',
        );
      } catch (error) {
        this.logger.error(
          { orderId: reservation.orderId, err: error },
          'Failed to release expired reservation — will retry next tick',
        );
      }
    }

    if (expired.length > 0) {
      this.logger.info(
        { count: expired.length },
        'Released expired reservations past their TTL',
      );
    }
  }
}
