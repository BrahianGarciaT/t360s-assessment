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

/** Se lanza cuando un UPDATE condicional de stock afecta cero filas — revierte toda la transacción de reserve. */
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
   * Todos los UPDATE de items se ejecutan en UNA sola transacción; los items se suman por productId y
   * se aplican en orden ASC de productId (un orden de bloqueo determinista evita
   * deadlocks entre dos órdenes concurrentes que tocan los mismos SKUs en
   * orden opuesto). Cualquier UPDATE condicional que afecte cero filas lanza una excepción,
   * lo que revierte también todos los UPDATE anteriores en esta transacción.
   */
  async reserve(input: ReserveInput, ttlMinutes: number): Promise<Reservation> {
    const items = this.sumAndSortItems(input.items);

    return this.dataSource.transaction(async (manager) => {
      for (const item of items) {
        // El driver de Postgres de TypeORM devuelve el resultado de un `manager.query()`
        // que no es un SELECT como una tupla `[rows, affectedRowCount]`, no como un
        // array de filas plano — desestructurar `rows` aquí (y no la tupla en sí) es
        // necesario, de lo contrario `rows.length` leería la longitud propia de la tupla
        // (siempre 2) en lugar de cuántas filas realmente coincidieron con el UPDATE
        // condicional, anulando silenciosamente la protección contra sobreventa
        // (oversell) para toda reserva, sin importar la disponibilidad real.
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
   * Idempotente por `eventId`, siguiendo el mismo patrón de deduplicación por eventId
   * de `AuditService.createLog`: un evento finalize/release reentregado que trae
   * el MISMO `eventId` ya registrado en esta reserva (`processedEventId`)
   * es un no-op — esta es la clave de deduplicación principal, verificada antes de tocar el stock.
   * Se mantiene una protección de estado terminal como respaldo defensivo para el caso
   * (que no debería ocurrir nunca en operación normal) de que llegue un eventId DISTINTO
   * para una reserva ya en estado terminal — sigue siendo un no-op seguro, nunca una
   * doble aplicación, pero se distingue en los logs de una repetición real del mismo eventId.
   *
   * La lectura de la reserva toma un lock `pessimistic_write` (`SELECT ... FOR
   * UPDATE`) en lugar de una lectura simple: bajo READ COMMITTED, dos llamadas
   * concurrentes a `finalize()` para el mismo `orderId` (por ejemplo, el reaper de TTL
   * compitiendo con un commit entregado por el outbox) podrían de otro modo
   * leer ambas la fila mientras todavía está `HELD`, pasar ambas la protección de
   * estado terminal, y mutar ambas el stock — una escritura pisando a la otra y
   * arriesgando una violación del check-constraint de stock. El lock las serializa:
   * la segunda llamada se bloquea hasta que la primera transacción hace commit,
   * luego lee el estado POST-finalize y no hace nada (no-op) mediante la protección
   * de estado terminal de abajo, en lugar de avanzar sobre una lectura obsoleta.
   */
  async finalize(
    orderId: string,
    action: FinalizeAction,
    eventId: string,
    releasedReason?: ReleasedReason,
  ): Promise<Reservation | null> {
    return this.dataSource.transaction(async (manager) => {
      const reservationRepo = manager.getRepository(Reservation);
      const reservation = await reservationRepo.findOne({
        where: { orderId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!reservation) {
        return null;
      }

      if (reservation.processedEventId === eventId) {
        return reservation;
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
      reservation.processedEventId = eventId;
      if (action === 'release') {
        reservation.releasedReason = releasedReason ?? null;
      }

      return reservationRepo.save(reservation);
    });
  }

  /** Lectura no transaccional usada por el camino de deduplicación 23505 del service. */
  async findByOrderId(orderId: string): Promise<Reservation | null> {
    return this.repository.findOne({ where: { orderId } });
  }

  /** Reservas en estado held que superaron su TTL, de más antigua a más reciente — alimenta al reaper `@Cron`. */
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

  /** Upsert idempotente que respalda `PUT /stock/:productId` — es un punto de apoyo para fixtures/demo, no una API de reabastecimiento. */
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
