import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ReserveStockRequest, ReserveStockResponse } from '@app/shared';
import {
  InventoryRepository,
  ReservationRejectedError,
} from './inventory.repository';
import { getInventoryConfig, InventoryConfig } from './inventory.constants';
import { ReleasedReason } from './entities/reservation.entity';
import { StockItem } from './entities/stock-item.entity';

// Postgres unique-violation SQLSTATE (raised on the reservations.orderId PK).
const POSTGRES_UNIQUE_VIOLATION_ERROR_CODE = '23505';

@Injectable()
export class InventoryService {
  private readonly config: InventoryConfig;

  constructor(
    private readonly repository: InventoryRepository,
    @InjectPinoLogger(InventoryService.name)
    private readonly logger: PinoLogger,
  ) {
    this.config = getInventoryConfig();
  }

  /**
   * At-least-once redelivery from the orders outbox means the same orderId
   * can arrive more than once. A duplicate is a successful no-op, not an
   * error — mirrors AuditService.createLog's 11000 catch, but for
   * Postgres's 23505 unique violation on the reservations.orderId PK.
   */
  async reserve(request: ReserveStockRequest): Promise<ReserveStockResponse> {
    try {
      const reservation = await this.repository.reserve(
        { orderId: request.orderId, items: request.items },
        this.config.reservationTtlMinutes,
      );
      return {
        ok: true,
        orderId: reservation.orderId,
        expiresAt: reservation.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof ReservationRejectedError) {
        return {
          ok: false,
          reason: error.reason,
          shortfalls: error.shortfalls,
        };
      }

      if (this.isDuplicateKeyError(error)) {
        this.logger.warn(
          { orderId: request.orderId },
          'Duplicate reservation orderId received — treating as a no-op',
        );
        const existing = await this.repository.findByOrderId(request.orderId);
        if (existing) {
          return {
            ok: true,
            orderId: existing.orderId,
            expiresAt: existing.expiresAt.toISOString(),
          };
        }
      }

      throw error;
    }
  }

  /**
   * Dedup is keyed by `eventId` (mirrors `AuditService.createLog`'s
   * dedup-by-eventId pattern), with the repository's terminal-state guard
   * as a defensive fallback: an unknown, already-processed, or already
   * terminal reservation still acks `{ ok: true }` here — `orders` is
   * HTTP-only and has no callback channel to react to a late failure.
   */
  async commit(
    orderId: string,
    eventId: string,
  ): Promise<{ ok: true; orderId: string }> {
    const reservation = await this.repository.finalize(
      orderId,
      'commit',
      eventId,
    );
    if (!reservation) {
      this.logger.warn(
        { orderId, eventId },
        'No reservation found for orderId — ignoring commit (no-op ack)',
      );
    }
    return { ok: true, orderId };
  }

  async release(
    orderId: string,
    eventId: string,
    reason: ReleasedReason,
  ): Promise<{ ok: true; orderId: string }> {
    const reservation = await this.repository.finalize(
      orderId,
      'release',
      eventId,
      reason,
    );
    if (!reservation) {
      this.logger.warn(
        { orderId, eventId },
        'No reservation found for orderId — ignoring release (no-op ack)',
      );
    }
    return { ok: true, orderId };
  }

  /** Idempotent fixture/demo seam backing `PUT /stock/:productId` — not a restock API. */
  async setStock(productId: string, quantity: number): Promise<StockItem> {
    return this.repository.upsertStock(productId, quantity);
  }

  async getStockLevel(productId: string): Promise<StockItem | null> {
    return this.repository.getStock(productId);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_ERROR_CODE
    );
  }
}
