import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, EMPTY } from 'rxjs';
import {
  ORDER_EVENTS,
  OrderStatus,
  OrderStatusChangedEvent,
} from '@app/shared';
import { OrdersRepository } from './orders.repository';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SearchOrdersDto } from './dto/search-orders.dto';
import { Order } from './entities/order.entity';
import { AUDIT_TCP_CLIENT } from './orders.constants';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly ordersRepository: OrdersRepository,
    @Inject(AUDIT_TCP_CLIENT) private readonly auditClient: ClientProxy,
  ) {}

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const totalAmount = dto.items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0,
    );

    const order = await this.ordersRepository.create({
      userId: dto.userId,
      items: dto.items,
      notes: dto.notes ?? null,
      totalAmount,
      status: OrderStatus.PENDING,
    });

    this.emitStatusChanged({
      orderId: order.id,
      fromStatus: null,
      toStatus: OrderStatus.PENDING,
      timestamp: new Date(),
    });

    return order;
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

  async updateStatus(id: string, dto: UpdateStatusDto): Promise<Order> {
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
    const updated = await this.ordersRepository.save(order);

    this.emitStatusChanged({
      orderId: updated.id,
      fromStatus,
      toStatus: updated.status,
      timestamp: new Date(),
    });

    return updated;
  }

  private emitStatusChanged(event: OrderStatusChangedEvent): void {
    this.auditClient
      .emit(ORDER_EVENTS.STATUS_CHANGED, event)
      .pipe(
        catchError((error) => {
          this.logger.error(
            `Failed to emit ${ORDER_EVENTS.STATUS_CHANGED} for order ${event.orderId}`,
            error,
          );
          return EMPTY;
        }),
      )
      .subscribe();
  }
}
