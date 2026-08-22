import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  INVENTORY_EVENTS,
  INVENTORY_PATTERNS,
  ORDER_EVENTS,
  OrderStatus,
  ReserveStockRequest,
  ReserveStockResponse,
} from '@app/shared';
import { OrdersRepository, OutboxEventFactory } from './orders.repository';
import { OutboxEventInput } from './outbox.repository';
import {
  getInventoryClientConfig,
  INVENTORY_TCP_CLIENT,
} from './orders.constants';
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
  private readonly inventoryConfig = getInventoryClientConfig();

  constructor(
    private readonly ordersRepository: OrdersRepository,
    @Inject(INVENTORY_TCP_CLIENT)
    private readonly inventoryClient: ClientProxy,
  ) {}

  async createOrder(
    dto: CreateOrderDto,
    correlationId?: string,
  ): Promise<Order> {
    const id = randomUUID();
    const totalAmount = dto.items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0,
    );

    // Reserva el stock ANTES de la transacción de la orden — deliberadamente
    // fuera de la tx local (decisión de diseño #1). Un rechazo o un fallo de
    // transporte nunca debe crear una fila de orden ni una reserva parcial.
    await this.reserveStock(id, dto.items, correlationId);

    return this.ordersRepository.create(
      {
        id,
        userId: dto.userId,
        items: dto.items,
        notes: dto.notes ?? null,
        totalAmount,
        status: OrderStatus.PENDING,
      },
      (created) => [
        {
          eventType: ORDER_EVENTS.STATUS_CHANGED,
          payload: {
            orderId: created.id,
            fromStatus: null,
            toStatus: OrderStatus.PENDING,
            timestamp: new Date(),
            metadata: correlationId ? { correlationId } : undefined,
          },
        },
      ],
    );
  }

  /**
   * Llama a `inventory.reserve` de forma síncrona a través de
   * `INVENTORY_TCP_CLIENT`. Mapea un rechazo resuelto a 409 y cualquier
   * fallo de transporte/timeout a 503 — el sistema nunca degrada en modo
   * abierto (decisión de diseño #6, spec
   * "Hard failure when inventory is unreachable").
   */
  private async reserveStock(
    orderId: string,
    items: CreateOrderDto['items'],
    correlationId?: string,
  ): Promise<void> {
    const request: ReserveStockRequest = {
      orderId,
      items: items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      correlationId,
    };

    let response: ReserveStockResponse;
    try {
      response = await firstValueFrom(
        this.inventoryClient
          .send<ReserveStockResponse, ReserveStockRequest>(
            INVENTORY_PATTERNS.RESERVE,
            request,
          )
          .pipe(timeout(this.inventoryConfig.sendTimeoutMs)),
      );
    } catch {
      throw new ServiceUnavailableException(
        'Inventory service unavailable — order was not created',
      );
    }

    if (!response.ok) {
      throw new ConflictException({
        reason: response.reason,
        shortfalls: response.shortfalls,
      });
    }
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
    const updated = await this.ordersRepository.transitionStatus(
      id,
      (order) => {
        const allowed = VALID_TRANSITIONS[order.status];
        if (!allowed.includes(dto.status)) {
          throw new BadRequestException(
            `Cannot transition from ${order.status} to ${dto.status}`,
          );
        }

        const fromStatus = order.status;
        order.status = dto.status;

        const buildEvents: OutboxEventFactory = (saved) => {
          const metadata = correlationId ? { correlationId } : undefined;
          const events: OutboxEventInput[] = [
            {
              eventType: ORDER_EVENTS.STATUS_CHANGED,
              payload: {
                orderId: saved.id,
                fromStatus,
                toStatus: saved.status,
                timestamp: new Date(),
                metadata,
              },
            },
          ];

          // Fan-out de finalize/release en la misma transacción (decisión de
          // diseño #7): el cambio de estado de la orden y el evento de
          // inventario son todo-o-nada.
          if (saved.status === OrderStatus.CONFIRMED) {
            events.push({
              eventType: INVENTORY_EVENTS.COMMIT_REQUESTED,
              payload: {
                orderId: saved.id,
                timestamp: new Date(),
                metadata,
              },
            });
          } else if (saved.status === OrderStatus.CANCELLED) {
            events.push({
              eventType: INVENTORY_EVENTS.RELEASE_REQUESTED,
              payload: {
                orderId: saved.id,
                timestamp: new Date(),
                metadata,
              },
            });
          }

          return events;
        };

        return buildEvents;
      },
    );

    if (!updated) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    return updated;
  }
}
