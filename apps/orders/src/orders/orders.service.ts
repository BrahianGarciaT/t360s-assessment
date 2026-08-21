import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ORDER_EVENTS, OrderStatus } from '@app/shared';
import { OrdersRepository } from './orders.repository';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SearchOrdersDto } from './dto/search-orders.dto';
import { Order } from './entities/order.entity';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

@Injectable()
export class OrdersService {
  constructor(private readonly ordersRepository: OrdersRepository) {}

  async createOrder(
    dto: CreateOrderDto,
    correlationId?: string,
  ): Promise<Order> {
    const totalAmount = dto.items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0,
    );

    return this.ordersRepository.create(
      {
        userId: dto.userId,
        items: dto.items,
        notes: dto.notes ?? null,
        totalAmount,
        status: OrderStatus.PENDING,
      },
      (created) => ({
        eventType: ORDER_EVENTS.STATUS_CHANGED,
        payload: {
          orderId: created.id,
          fromStatus: null,
          toStatus: OrderStatus.PENDING,
          timestamp: new Date(),
          metadata: correlationId ? { correlationId } : undefined,
        },
      }),
    );
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.ordersRepository.findById(id);

    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    return order;
  }

  async findAll(
    query: QueryOrdersDto,
  ): Promise<{ data: Order[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.ordersRepository.findAll(query);
    return { data, total, page: query.page ?? 1, limit: query.limit ?? 10 };
  }

  async searchOrders(
    dto: SearchOrdersDto,
  ): Promise<{ data: Order[]; total: number; page: number; limit: number }> {
    const { q, page = 1, limit = 10 } = dto;
    const [data, total] = await this.ordersRepository.searchByText(
      q,
      page,
      limit,
    );
    return { data, total, page, limit };
  }

  async updateStatus(
    id: string,
    dto: UpdateStatusDto,
    correlationId?: string,
  ): Promise<Order> {
    const order = await this.ordersRepository.findById(id);

    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot transition from ${order.status} to ${dto.status}`,
      );
    }

    const fromStatus = order.status;
    order.status = dto.status;

    return this.ordersRepository.save(order, (saved) => ({
      eventType: ORDER_EVENTS.STATUS_CHANGED,
      payload: {
        orderId: saved.id,
        fromStatus,
        toStatus: saved.status,
        timestamp: new Date(),
        metadata: correlationId ? { correlationId } : undefined,
      },
    }));
  }
}
