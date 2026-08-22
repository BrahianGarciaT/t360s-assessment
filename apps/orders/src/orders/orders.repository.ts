import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { OutboxRepository, OutboxEventInput } from './outbox.repository';

export type OutboxEventFactory = (order: Order) => OutboxEventInput[];

@Injectable()
export class OrdersRepository implements OnModuleInit {
  constructor(
    @InjectRepository(Order)
    private readonly repository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly outboxRepository: OutboxRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ORDERS_SEARCH_VECTOR" ON orders USING gin("searchVector")`,
    );
  }

  /**
   * Creates the order, refreshes its search vector, and inserts every outbox
   * event returned by the factory in ONE transaction. If any outbox insert
   * fails, everything rolls back — the order is never persisted.
   */
  async create(
    data: Partial<Order>,
    event: OutboxEventFactory,
  ): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(Order);
      const order = await orderRepo.save(orderRepo.create(data));
      await this.updateSearchVector(manager, order.id);
      for (const outboxEvent of event(order)) {
        await this.outboxRepository.insertWithin(manager, outboxEvent);
      }
      return order;
    });
  }

  async findAll(query: QueryOrdersDto): Promise<[Order[], number]> {
    const { status, userId, page = 1, limit = 10 } = query;
    const qb = this.repository.createQueryBuilder('order');

    if (status) {
      qb.andWhere('order.status = :status', { status });
    }
    if (userId) {
      qb.andWhere('order.userId = :userId', { userId });
    }

    qb.orderBy('order.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    return qb.getManyAndCount();
  }

  async findById(id: string): Promise<Order | null> {
    return this.repository.findOne({ where: { id } });
  }

  /**
   * Persists an updated order, refreshes its search vector, and inserts
   * every outbox event returned by the factory in ONE transaction — same
   * all-or-nothing guarantee as `create`. A status transition can produce
   * more than one event (e.g. `order.status_changed` plus an inventory
   * finalize/release event on CONFIRMED/CANCELLED).
   */
  async save(order: Order, event: OutboxEventFactory): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(Order).save(order);
      await this.updateSearchVector(manager, saved.id);
      for (const outboxEvent of event(saved)) {
        await this.outboxRepository.insertWithin(manager, outboxEvent);
      }
      return saved;
    });
  }

  async searchByText(
    query: string,
    page: number = 1,
    limit: number = 10,
  ): Promise<[Order[], number]> {
    return this.repository
      .createQueryBuilder('order')
      .where(`"order"."searchVector" @@ plainto_tsquery('english', :query)`, {
        query,
      })
      .orderBy(
        `ts_rank("order"."searchVector", plainto_tsquery('english', :query))`,
        'DESC',
      )
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  private async updateSearchVector(
    manager: EntityManager,
    id: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE orders
       SET "searchVector" = to_tsvector('english',
         coalesce(notes, '') || ' ' ||
         coalesce((
           SELECT string_agg(item->>'productName', ' ')
           FROM jsonb_array_elements(items) AS item
         ), '')
       )
       WHERE id = $1`,
      [id],
    );
  }
}
