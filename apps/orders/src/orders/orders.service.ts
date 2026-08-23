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
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom, timeout } from 'rxjs';
import {
  INVENTORY_EVENTS,
  INVENTORY_PATTERNS,
  InventoryFinalizeEvent,
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
import {
  CircuitOpenError,
  InventoryCircuitBreaker,
} from './inventory-circuit-breaker';
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
    private readonly configService: ConfigService,
    private readonly circuitBreaker: InventoryCircuitBreaker,
    @InjectPinoLogger(OrdersService.name)
    private readonly logger: PinoLogger,
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
   * `INVENTORY_TCP_CLIENT`, con el intento TCP gateado por
   * `circuitBreaker.execute()`. Mapea un rechazo resuelto a 409 y cualquier
   * fallo de transporte/timeout (real o por circuito abierto) a 503 — el
   * sistema nunca degrada en modo abierto (decisión de diseño #6, spec
   * "Hard failure when inventory is unreachable"). Solo un fallo de
   * transporte real dispara `releaseOrphanedReservation`: si el circuito
   * está abierto, `CircuitOpenError` corta antes de cualquier intento TCP,
   * por lo que no hay reserva huérfana que liberar. El branch de rechazo
   * resuelto (`response.ok === false` → 409) vive fuera del breaker: nunca
   * cuenta como fallo de transporte.
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
      apiKey: this.configService.get<string>('API_KEY', ''),
    };

    let response: ReserveStockResponse;
    try {
      response = await this.circuitBreaker.execute(() =>
        firstValueFrom(
          this.inventoryClient
            .send<ReserveStockResponse, ReserveStockRequest>(
              INVENTORY_PATTERNS.RESERVE,
              request,
            )
            .pipe(timeout(this.inventoryConfig.sendTimeoutMs)),
        ),
      );
    } catch (error) {
      // No TCP attempt was made when the breaker short-circuits — nothing to
      // release. Only a real transport failure can leave inventory holding
      // an orphaned reservation.
      if (!(error instanceof CircuitOpenError)) {
        this.releaseOrphanedReservation(orderId, correlationId);
      }
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

  /**
   * Best-effort: si inventory en realidad SÍ procesó la reserva después de
   * que el cliente dejó de esperar (timeout u otro fallo de transporte), esa
   * reserva queda sosteniendo stock sin ninguna orden detrás — sin este
   * release, recién se libera cuando vence el TTL (hasta
   * `INVENTORY_RESERVATION_TTL_MINUTES`). Fire-and-forget: nunca debe
   * bloquear ni hacer fallar la respuesta 503 que el caller ya recibió — si
   * también falla, el TTL reaper sigue siendo la red de seguridad final.
   */
  private releaseOrphanedReservation(
    orderId: string,
    correlationId?: string,
  ): void {
    const event: InventoryFinalizeEvent = {
      eventId: `internal:orphan-release:${orderId}`,
      orderId,
      timestamp: new Date(),
      metadata: correlationId ? { correlationId } : undefined,
      reason: 'orphaned',
      apiKey: this.configService.get<string>('API_KEY', ''),
    };

    this.inventoryClient
      .send<{ ok: true; orderId: string }, InventoryFinalizeEvent>(
        INVENTORY_PATTERNS.RELEASE,
        event,
      )
      .subscribe({
        error: (error: unknown) => {
          this.logger.warn(
            {
              orderId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Best-effort orphaned-reservation release failed — the TTL reaper remains the final safety net',
          );
        },
      });
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
                reason: 'cancelled',
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
