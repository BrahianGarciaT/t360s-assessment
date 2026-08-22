import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { of, throwError, TimeoutError } from 'rxjs';
import {
  INVENTORY_EVENTS,
  INVENTORY_PATTERNS,
  ORDER_EVENTS,
  OrderStatus,
} from '@app/shared';
import { OrdersService } from './orders.service';
import { OrdersRepository, OutboxEventFactory } from './orders.repository';
import { INVENTORY_TCP_CLIENT } from './orders.constants';
import { Order } from './entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';

jest.mock('crypto', () => ({
  randomUUID: jest.fn(),
}));

import { randomUUID } from 'crypto';

const GENERATED_ID = 'order-uuid-1';

describe('OrdersService', () => {
  let service: OrdersService;
  let repository: jest.Mocked<
    Pick<
      OrdersRepository,
      'create' | 'findAll' | 'searchByText' | 'findById' | 'transitionStatus'
    >
  >;
  let inventoryClient: { send: jest.Mock };

  const buildOrder = (overrides: Partial<Order> = {}): Order =>
    ({
      id: GENERATED_ID,
      userId: 'user-1',
      items: [
        { productId: 'p1', productName: 'Product 1', quantity: 2, price: 10 },
      ],
      status: OrderStatus.PENDING,
      totalAmount: 20,
      notes: null,
      searchVector: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Order;

  beforeEach(async () => {
    repository = {
      create: jest.fn(),
      findAll: jest.fn(),
      searchByText: jest.fn(),
      findById: jest.fn(),
      transitionStatus: jest.fn(),
    };
    inventoryClient = { send: jest.fn() };
    (randomUUID as jest.Mock).mockReturnValue(GENERATED_ID);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: OrdersRepository, useValue: repository },
        { provide: INVENTORY_TCP_CLIENT, useValue: inventoryClient },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createOrder', () => {
    const dto: CreateOrderDto = {
      userId: 'user-1',
      items: [
        { productId: 'p1', productName: 'Product 1', quantity: 2, price: 10 },
        { productId: 'p2', productName: 'Product 2', quantity: 3, price: 5 },
      ],
    };

    it('pre-generates the order id and reserves stock over the TCP client before creating the order', async () => {
      inventoryClient.send.mockReturnValue(
        of({
          ok: true,
          orderId: GENERATED_ID,
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      repository.create.mockResolvedValue(buildOrder({ totalAmount: 35 }));

      await service.createOrder(dto, 'corr-123');

      expect(inventoryClient.send).toHaveBeenCalledWith(
        INVENTORY_PATTERNS.RESERVE,
        {
          orderId: GENERATED_ID,
          items: [
            { productId: 'p1', quantity: 2 },
            { productId: 'p2', quantity: 3 },
          ],
          correlationId: 'corr-123',
        },
      );
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: GENERATED_ID,
          userId: 'user-1',
          totalAmount: 35,
          status: OrderStatus.PENDING,
        }),
        expect.any(Function),
      );

      const reserveCallOrder = inventoryClient.send.mock.invocationCallOrder[0];
      const createCallOrder = repository.create.mock.invocationCallOrder[0];
      expect(reserveCallOrder).toBeLessThan(createCallOrder);
    });

    it('calculates totalAmount from items and hands the repository a single-element event array', async () => {
      inventoryClient.send.mockReturnValue(
        of({ ok: true, orderId: GENERATED_ID, expiresAt: 'x' }),
      );
      const created = buildOrder({ totalAmount: 35 });
      repository.create.mockResolvedValue(created);

      const result = await service.createOrder(dto);

      const [, eventFactory] = repository.create.mock.calls[0] as [
        unknown,
        OutboxEventFactory,
      ];
      const events = eventFactory(created);
      expect(events).toEqual([
        {
          eventType: ORDER_EVENTS.STATUS_CHANGED,
          payload: expect.objectContaining({
            orderId: created.id,
            fromStatus: null,
            toStatus: OrderStatus.PENDING,
          }),
        },
      ]);
      expect(result).toBe(created);
    });

    it('attaches the correlation id as event metadata when provided', async () => {
      inventoryClient.send.mockReturnValue(
        of({ ok: true, orderId: GENERATED_ID, expiresAt: 'x' }),
      );
      const created = buildOrder();
      repository.create.mockResolvedValue(created);

      await service.createOrder(dto, 'corr-123');

      const [, eventFactory] = repository.create.mock.calls[0] as [
        unknown,
        OutboxEventFactory,
      ];
      const events = eventFactory(created);
      expect(events[0].payload.metadata).toEqual({ correlationId: 'corr-123' });
    });

    it('omits metadata when no correlation id is provided', async () => {
      inventoryClient.send.mockReturnValue(
        of({ ok: true, orderId: GENERATED_ID, expiresAt: 'x' }),
      );
      const created = buildOrder();
      repository.create.mockResolvedValue(created);

      await service.createOrder(dto);

      const [, eventFactory] = repository.create.mock.calls[0] as [
        unknown,
        OutboxEventFactory,
      ];
      const events = eventFactory(created);
      expect(events[0].payload.metadata).toBeUndefined();
    });

    it('rejects with 409 Conflict when inventory reports insufficient stock, without creating the order', async () => {
      inventoryClient.send.mockReturnValue(
        of({
          ok: false,
          reason: 'INSUFFICIENT_STOCK',
          shortfalls: [{ productId: 'p1', requested: 2, available: 1 }],
        }),
      );

      await expect(service.createOrder(dto)).rejects.toThrow(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects with 409 Conflict when inventory reports an unknown product (triangulation)', async () => {
      inventoryClient.send.mockReturnValue(
        of({ ok: false, reason: 'UNKNOWN_PRODUCT', shortfalls: [] }),
      );

      await expect(service.createOrder(dto)).rejects.toThrow(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects with 503 Service Unavailable when inventory is unreachable, without creating the order', async () => {
      inventoryClient.send.mockReturnValue(
        throwError(() => new Error('ECONNREFUSED')),
      );

      await expect(service.createOrder(dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects with 503 Service Unavailable when the reserve call times out (triangulation)', async () => {
      inventoryClient.send.mockReturnValue(
        throwError(() => new TimeoutError()),
      );

      await expect(service.createOrder(dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns the order when it exists', async () => {
      const order = buildOrder();
      repository.findById.mockResolvedValue(order);

      const result = await service.findOne(order.id);

      expect(repository.findById).toHaveBeenCalledWith(order.id);
      expect(result).toBe(order);
    });

    it('throws NotFoundException when the order does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    // Imita el contrato real de OrdersRepository#transitionStatus: lee la
    // orden, invoca `transition` (que valida + muta `order.status` in place
    // y devuelve el event factory), y resuelve la orden mutada — capturando
    // el event factory en `buildEvents` para que los tests puedan hacer
    // assert sobre los eventos que produce.
    const mockTransitionStatus = (
      order: Order,
    ): { buildEvents: () => OutboxEventFactory } => {
      let buildEvents: OutboxEventFactory;
      repository.transitionStatus.mockImplementation(
        async (_id, transition) => {
          buildEvents = transition(order);
          return order;
        },
      );
      return { buildEvents: () => buildEvents };
    };

    it('updates status and hands the repository an event array with order.status_changed and inventory.commit_requested on CONFIRMED', async () => {
      const order = buildOrder({ status: OrderStatus.PENDING });
      const captured = mockTransitionStatus(order);

      const result = await service.updateStatus(order.id, {
        status: OrderStatus.CONFIRMED,
      });

      expect(result.status).toBe(OrderStatus.CONFIRMED);
      const events = captured.buildEvents()(order);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        eventType: ORDER_EVENTS.STATUS_CHANGED,
        payload: expect.objectContaining({
          orderId: order.id,
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CONFIRMED,
        }),
      });
      expect(events[1]).toEqual({
        eventType: INVENTORY_EVENTS.COMMIT_REQUESTED,
        payload: expect.objectContaining({ orderId: order.id }),
      });
    });

    it('emits inventory.release_requested on CANCELLED (triangulation)', async () => {
      const order = buildOrder({ status: OrderStatus.PENDING });
      const captured = mockTransitionStatus(order);

      await service.updateStatus(order.id, { status: OrderStatus.CANCELLED });

      const events = captured.buildEvents()(order);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        eventType: INVENTORY_EVENTS.RELEASE_REQUESTED,
        payload: expect.objectContaining({ orderId: order.id }),
      });
    });

    it('emits only order.status_changed on a transition that does not touch inventory (SHIPPED)', async () => {
      const order = buildOrder({ status: OrderStatus.CONFIRMED });
      const captured = mockTransitionStatus(order);

      await service.updateStatus(order.id, { status: OrderStatus.SHIPPED });

      const events = captured.buildEvents()(order);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe(ORDER_EVENTS.STATUS_CHANGED);
    });

    it('attaches the correlation id as metadata on both events when provided', async () => {
      const order = buildOrder({ status: OrderStatus.PENDING });
      const captured = mockTransitionStatus(order);

      await service.updateStatus(
        order.id,
        { status: OrderStatus.CONFIRMED },
        'corr-456',
      );

      const events = captured.buildEvents()(order);
      expect(events[0].payload.metadata).toEqual({ correlationId: 'corr-456' });
      expect(events[1].payload.metadata).toEqual({ correlationId: 'corr-456' });
    });

    it('throws BadRequestException on an invalid transition (DELIVERED -> PENDING)', async () => {
      const order = buildOrder({ status: OrderStatus.DELIVERED });
      mockTransitionStatus(order);

      await expect(
        service.updateStatus(order.id, { status: OrderStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
      expect(order.status).toBe(OrderStatus.DELIVERED);
    });

    it('throws NotFoundException when the order does not exist', async () => {
      repository.transitionStatus.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing-id', { status: OrderStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('delegates to the repository and returns paginated results with defaults', async () => {
      const orders = [buildOrder()];
      repository.findAll.mockResolvedValue([orders, 1]);

      const result = await service.findAll({});

      expect(repository.findAll).toHaveBeenCalledWith({});
      expect(result).toEqual({ data: orders, total: 1, page: 1, limit: 10 });
    });

    it('propagates page and limit from the query', async () => {
      const orders = [buildOrder()];
      repository.findAll.mockResolvedValue([orders, 1]);

      const result = await service.findAll({ page: 2, limit: 5 });

      expect(result).toEqual({ data: orders, total: 1, page: 2, limit: 5 });
    });
  });

  describe('searchOrders', () => {
    it('delegates to the repository and returns paginated results with defaults', async () => {
      const orders = [buildOrder()];
      repository.searchByText.mockResolvedValue([orders, 1]);

      const result = await service.searchOrders({ q: 'widget' });

      expect(repository.searchByText).toHaveBeenCalledWith('widget', 1, 10);
      expect(result).toEqual({ data: orders, total: 1, page: 1, limit: 10 });
    });

    it('propagates page and limit from the query', async () => {
      const orders = [buildOrder()];
      repository.searchByText.mockResolvedValue([orders, 1]);

      const result = await service.searchOrders({
        q: 'widget',
        page: 3,
        limit: 20,
      });

      expect(repository.searchByText).toHaveBeenCalledWith('widget', 3, 20);
      expect(result).toEqual({ data: orders, total: 1, page: 3, limit: 20 });
    });
  });
});
