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

// SQLSTATE de violación de unicidad de Postgres (se lanza sobre la PK reservations.orderId).
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
   * La reentrega at-least-once desde el outbox de orders implica que el mismo orderId
   * puede llegar más de una vez. Un duplicado es un no-op exitoso, no un
   * error — sigue el mismo patrón que el catch de 11000 en AuditService.createLog,
   * pero para la violación de unicidad 23505 de Postgres sobre la PK reservations.orderId.
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
   * La deduplicación se indexa por `eventId` (sigue el mismo patrón de deduplicación
   * por eventId de `AuditService.createLog`), con la protección de estado terminal
   * del repository como respaldo defensivo: una reserva desconocida, ya procesada, o
   * ya en estado terminal igualmente responde con ack `{ ok: true }` aquí — `orders`
   * es solo HTTP y no tiene un canal de callback para reaccionar ante un fallo tardío.
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

  /** Punto de apoyo idempotente para fixtures/demo que respalda `PUT /stock/:productId` — no es una API de reabastecimiento. */
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
