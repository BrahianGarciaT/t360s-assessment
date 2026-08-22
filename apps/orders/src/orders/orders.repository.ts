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
   * Crea la orden, refresca su vector de búsqueda, e inserta cada evento de
   * outbox devuelto por el factory en UNA sola transacción. Si falla
   * cualquier inserción en el outbox, todo se revierte — la orden nunca se
   * persiste.
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
   * Lee la orden con un `SELECT ... FOR UPDATE` (bloqueo de escritura
   * pesimista), deja que `transition` la valide y la mute in place, persiste
   * el resultado, refresca su vector de búsqueda, e inserta cada evento de
   * outbox devuelto por el factory de eventos de la transition — todo en UNA
   * sola transacción. El lock es lo que cierra la carrera de lost-update:
   * una llamada concurrente a `transitionStatus` sobre la misma orden se
   * bloquea en el row lock hasta que esta transacción hace commit o
   * rollback, por lo que siempre observa el estado posterior a la
   * transición, nunca datos obsoletos. `transition` puede lanzar (por
   * ejemplo, una transición de FSM inválida) — el error se propaga y la
   * transacción hace rollback sin efectos secundarios, ya que en ese punto
   * todavía no se había guardado nada.
   */
  async transitionStatus(
    id: string,
    transition: (order: Order) => OutboxEventFactory,
  ): Promise<Order | null> {
    return this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(Order);
      const order = await orderRepo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!order) {
        return null;
      }

      const buildEvents = transition(order);
      const saved = await orderRepo.save(order);
      await this.updateSearchVector(manager, saved.id);
      for (const outboxEvent of buildEvents(saved)) {
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
