import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { QueryOrdersDto } from './dto/query-orders.dto';

@Injectable()
export class OrdersRepository {
  constructor(
    @InjectRepository(Order)
    private readonly repository: Repository<Order>,
  ) {}

  async create(data: Partial<Order>): Promise<Order> {
    const order = this.repository.create(data);
    return this.repository.save(order);
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
    return this.repository.save(order);
  }
}
