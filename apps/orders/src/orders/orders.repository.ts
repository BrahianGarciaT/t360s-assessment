import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { QueryOrdersDto } from './dto/query-orders.dto';

@Injectable()
export class OrdersRepository implements OnModuleInit {
  constructor(
    @InjectRepository(Order)
    private readonly repository: Repository<Order>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repository.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ORDERS_SEARCH_VECTOR" ON orders USING gin("searchVector")`,
    );
  }

  async create(data: Partial<Order>): Promise<Order> {
    const order = this.repository.create(data);
    const saved = await this.repository.save(order);
    await this.updateSearchVector(saved.id);
    return saved;
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

  async save(order: Order): Promise<Order> {
    const saved = await this.repository.save(order);
    await this.updateSearchVector(saved.id);
    return saved;
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

  private async updateSearchVector(id: string): Promise<void> {
    await this.repository.query(
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
