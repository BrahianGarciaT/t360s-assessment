import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ORDER_EVENTS, OrderStatus } from '@app/shared';
import { OrdersService } from './orders.service';
import { OrdersRepository, OutboxEventFactory } from './orders.repository';
import { Order } from './entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';

describe('OrdersService', () => {
  let service: OrdersService;
  let repository: jest.Mocked<
    Pick<
      OrdersRepository,
      'create' | 'findAll' | 'searchByText' | 'findById' | 'save'
    >
  >;

  const buildOrder = (overrides: Partial<Order> = {}): Order =>
    ({
      id: 'order-1',
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
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: OrdersRepository, useValue: repository },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createOrder', () => {
    it('calculates totalAmount from items, sets PENDING status and hands the repository an event factory', async () => {
      const dto: CreateOrderDto = {
        userId: 'user-1',
        items: [
          { productId: 'p1', productName: 'Product 1', quantity: 2, price: 10 },
          { productId: 'p2', productName: 'Product 2', quantity: 3, price: 5 },
        ],
      };
      const created = buildOrder({ totalAmount: 35 });
      repository.create.mockResolvedValue(created);

      const result = await service.createOrder(dto);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          items: dto.items,
          notes: null,
          totalAmount: 35,
          status: OrderStatus.PENDING,
        }),
        expect.any(Function),
      );

      const [, eventFactory] = repository.create.mock.calls[0] as [
        unknown,
        OutboxEventFactory,
      ];
      const event = eventFactory(created);
      expect(event).toEqual({
        eventType: ORDER_EVENTS.STATUS_CHANGED,
        payload: expect.objectContaining({
          orderId: created.id,
          fromStatus: null,
          toStatus: OrderStatus.PENDING,
        }),
      });
      expect(result).toBe(created);
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
    it('updates status and hands the repository an event factory with fromStatus/toStatus on a valid transition', async () => {
      const order = buildOrder({ status: OrderStatus.PENDING });
      repository.findById.mockResolvedValue(order);
      repository.save.mockImplementation(async (o: Order) => o);

      const result = await service.updateStatus(order.id, {
        status: OrderStatus.CONFIRMED,
      });

      expect(result.status).toBe(OrderStatus.CONFIRMED);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.CONFIRMED }),
        expect.any(Function),
      );

      const [savedOrder, eventFactory] = repository.save.mock.calls[0] as [
        Order,
        OutboxEventFactory,
      ];
      const event = eventFactory(savedOrder);
      expect(event).toEqual({
        eventType: ORDER_EVENTS.STATUS_CHANGED,
        payload: expect.objectContaining({
          orderId: order.id,
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CONFIRMED,
        }),
      });
    });

    it('throws BadRequestException on an invalid transition (DELIVERED -> PENDING)', async () => {
      const order = buildOrder({ status: OrderStatus.DELIVERED });
      repository.findById.mockResolvedValue(order);

      await expect(
        service.updateStatus(order.id, { status: OrderStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the order does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing-id', { status: OrderStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
      expect(repository.save).not.toHaveBeenCalled();
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
