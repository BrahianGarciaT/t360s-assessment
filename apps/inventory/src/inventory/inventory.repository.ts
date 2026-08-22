import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { StockShortfall, ReserveStockItem } from '@app/shared';
import { StockItem } from './entities/stock-item.entity';
import {
  Reservation,
  ReservationItem,
  ReservationStatus,
  ReleasedReason,
} from './entities/reservation.entity';

export interface ReserveInput {
  orderId: string;
  items: ReserveStockItem[];
}

export type FinalizeAction = 'commit' | 'release';

/** Thrown when a conditional stock UPDATE affects zero rows — rolls back the whole reserve transaction. */
export class ReservationRejectedError extends Error {
  constructor(
    public readonly reason: 'INSUFFICIENT_STOCK' | 'UNKNOWN_PRODUCT',
    public readonly shortfalls: StockShortfall[],
  ) {
    super(`Reservation rejected: ${reason}`);
    this.name = 'ReservationRejectedError';
  }
}

@Injectable()
export class InventoryRepository {
  constructor(
    @InjectRepository(Reservation)
    private readonly repository: Repository<Reservation>,
    @InjectRepository(StockItem)
    private readonly stockItemRepository: Repository<StockItem>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * All item UPDATEs run in ONE transaction, items summed per productId and
   * applied in productId ASC order (deterministic lock ordering avoids
   * deadlocks between two concurrent orders touching the same SKUs in
   * opposite order). Any conditional UPDATE affecting zero rows throws,
   * which rolls back every earlier UPDATE in this transaction too.
   */
  async reserve(input: ReserveInput, ttlMinutes: number): Promise<Reservation> {
    const items = this.sumAndSortItems(input.items);

    return this.dataSource.transaction(async (manager) => {
      for (const item of items) {
        // TypeORM's Postgres driver returns a non-SELECT `manager.query()`
        // result as a `[rows, affectedRowCount]` tuple, not a bare rows
        // array — destructuring `rows` here (not the tuple itself) is
        // required, otherwise `rows.length` reads the tuple's own length
        // (always 2) instead of how many rows the conditional UPDATE
        // actually matched, silently defeating the oversell-prevention
        // gate for every reservation, regardless of real availability.
        const [rows]: [unknown[], number] = await manager.query(
          `UPDATE stock_items
             SET reserved = reserved + $1
             WHERE "productId" = $2 AND (quantity - reserved) >= $1
             RETURNING "productId"`,
          [item.quantity, item.productId],
        );

        if (rows.length === 0) {
          const stock = await manager
            .getRepository(StockItem)
            .findOne({ where: { productId: item.productId } });

          const shortfall: StockShortfall = stock
            ? {
                productId: item.productId,
                requested: item.quantity,
                available: stock.quantity - stock.reserved,
              }
            : {
                productId: item.productId,
                requested: item.quantity,
                available: 0,
              };

          throw new ReservationRejectedError(
            stock ? 'INSUFFICIENT_STOCK' : 'UNKNOWN_PRODUCT',
            [shortfall],
          );
        }
      }

      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
      const reservationRepo = manager.getRepository(Reservation);
      const reservation = reservationRepo.create({
        orderId: input.orderId,
        items,
        status: ReservationStatus.HELD,
        expiresAt,
      });
      return reservationRepo.save(reservation);
    });
  }

  /**
   * Terminal-state guard: an already committed/released reservation is
   * returned unchanged (idempotent no-op) instead of re-applying stock
   * changes — protects against redelivered finalize/release events.
   */
  async finalize(
    orderId: string,
    action: FinalizeAction,
    releasedReason?: ReleasedReason,
  ): Promise<Reservation | null> {
    return this.dataSource.transaction(async (manager) => {
      const reservationRepo = manager.getRepository(Reservation);
      const reservation = await reservationRepo.findOne({
        where: { orderId },
      });

      if (!reservation) {
        return null;
      }

      if (reservation.status !== ReservationStatus.HELD) {
        return reservation;
      }

      for (const item of reservation.items) {
        if (action === 'commit') {
          await manager.query(
            `UPDATE stock_items
               SET quantity = quantity - $1, reserved = reserved - $1
               WHERE "productId" = $2`,
            [item.quantity, item.productId],
          );
        } else {
          await manager.query(
            `UPDATE stock_items
               SET reserved = reserved - $1
               WHERE "productId" = $2`,
            [item.quantity, item.productId],
          );
        }
      }

      reservation.status =
        action === 'commit'
          ? ReservationStatus.COMMITTED
          : ReservationStatus.RELEASED;
      if (action === 'release') {
        reservation.releasedReason = releasedReason ?? null;
      }

      return reservationRepo.save(reservation);
    });
  }

  /** Non-transactional read used by the service's 23505 dedup path. */
  async findByOrderId(orderId: string): Promise<Reservation | null> {
    return this.repository.findOne({ where: { orderId } });
  }

  /** Held reservations past their TTL, oldest first — feeds the `@Cron` reaper. */
  async claimExpired(batchSize: number): Promise<Reservation[]> {
    return this.repository.find({
      where: {
        status: ReservationStatus.HELD,
        expiresAt: LessThan(new Date()),
      },
      order: { expiresAt: 'ASC' },
      take: batchSize,
    });
  }

  /** Idempotent upsert backing `PUT /stock/:productId` — a fixture/demo seam, not a restock API. */
  async upsertStock(productId: string, quantity: number): Promise<StockItem> {
    const existing = await this.stockItemRepository.findOne({
      where: { productId },
    });

    if (!existing) {
      const created = this.stockItemRepository.create({
        productId,
        quantity,
        reserved: 0,
      });
      return this.stockItemRepository.save(created);
    }

    existing.quantity = quantity;
    return this.stockItemRepository.save(existing);
  }

  async getStock(productId: string): Promise<StockItem | null> {
    return this.stockItemRepository.findOne({ where: { productId } });
  }

  private sumAndSortItems(items: ReserveStockItem[]): ReservationItem[] {
    const totals = new Map<string, number>();
    for (const item of items) {
      totals.set(
        item.productId,
        (totals.get(item.productId) ?? 0) + item.quantity,
      );
    }
    return Array.from(totals.entries())
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
  }
}
