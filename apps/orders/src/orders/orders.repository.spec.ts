import { DataSource, EntityManager } from 'typeorm';
import { OrdersRepository } from './orders.repository';
import { OutboxRepository } from './outbox.repository';
import { Order } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OrderStatus } from '@app/shared';

describe('OrdersRepository', () => {
  let repository: OrdersRepository;
  let dataSource: { transaction: jest.Mock };
  let outboxRepository: jest.Mocked<Pick<OutboxRepository, 'insertWithin'>>;
  let manager: { getRepository: jest.Mock; query: jest.Mock };
  let orderManagerRepo: { create: jest.Mock; save: jest.Mock };

  const buildOrder = (overrides: Partial<Order> = {}): Order =>
    ({
      id: 'order-1',
      userId: 'user-1',
      items: [],
      status: OrderStatus.PENDING,
      totalAmount: 0,
      notes: null,
      searchVector: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Order;

  beforeEach(() => {
    orderManagerRepo = { create: jest.fn(), save: jest.fn() };
    manager = {
      getRepository: jest.fn().mockReturnValue(orderManagerRepo),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) =>
          cb(manager as unknown as EntityManager),
      ),
    };
    outboxRepository = { insertWithin: jest.fn() };

    repository = new OrdersRepository(
      // base repository used only by findAll/findById/save's non-transactional reads,
      // not exercised by the transactional paths under test here
      {} as never,
      dataSource as unknown as DataSource,
      outboxRepository as unknown as OutboxRepository,
    );
  });

  describe('create', () => {
    it('saves the order, refreshes the search vector, and inserts the outbox event within one transaction', async () => {
      const data = { userId: 'user-1', status: OrderStatus.PENDING };
      const created = { ...data };
      const saved = buildOrder();
      orderManagerRepo.create.mockReturnValue(created);
      orderManagerRepo.save.mockResolvedValue(saved);
      outboxRepository.insertWithin.mockResolvedValue({} as OutboxEvent);
      const eventFactory = jest
        .fn()
        .mockReturnValue({ eventType: 'order.status_changed', payload: {} });

      const result = await repository.create(data, eventFactory);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.getRepository).toHaveBeenCalledWith(Order);
      expect(orderManagerRepo.create).toHaveBeenCalledWith(data);
      expect(orderManagerRepo.save).toHaveBeenCalledWith(created);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders'),
        [saved.id],
      );
      expect(eventFactory).toHaveBeenCalledWith(saved);
      expect(outboxRepository.insertWithin).toHaveBeenCalledWith(manager, {
        eventType: 'order.status_changed',
        payload: {},
      });
      expect(result).toBe(saved);
    });

    it('rolls back the whole transaction (order is never returned) when the outbox insert fails', async () => {
      const data = { userId: 'user-1', status: OrderStatus.PENDING };
      const saved = buildOrder();
      orderManagerRepo.create.mockReturnValue(data);
      orderManagerRepo.save.mockResolvedValue(saved);
      outboxRepository.insertWithin.mockRejectedValue(
        new Error('outbox insert failed'),
      );
      const eventFactory = jest
        .fn()
        .mockReturnValue({ eventType: 'order.status_changed', payload: {} });

      await expect(repository.create(data, eventFactory)).rejects.toThrow(
        'outbox insert failed',
      );
      // proves the transaction callback propagated the failure instead of
      // swallowing it — dataSource.transaction() rolls back on rejection
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('save', () => {
    it('persists the updated order, refreshes the search vector, and inserts the outbox event within one transaction', async () => {
      const order = buildOrder({ status: OrderStatus.CONFIRMED });
      orderManagerRepo.save.mockResolvedValue(order);
      outboxRepository.insertWithin.mockResolvedValue({} as OutboxEvent);
      const eventFactory = jest
        .fn()
        .mockReturnValue({ eventType: 'order.status_changed', payload: {} });

      const result = await repository.save(order, eventFactory);

      expect(orderManagerRepo.save).toHaveBeenCalledWith(order);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders'),
        [order.id],
      );
      expect(eventFactory).toHaveBeenCalledWith(order);
      expect(outboxRepository.insertWithin).toHaveBeenCalledWith(manager, {
        eventType: 'order.status_changed',
        payload: {},
      });
      expect(result).toBe(order);
    });

    it('rolls back the whole transaction when the outbox insert fails on a status update (triangulation)', async () => {
      const order = buildOrder({ status: OrderStatus.SHIPPED });
      orderManagerRepo.save.mockResolvedValue(order);
      outboxRepository.insertWithin.mockRejectedValue(
        new Error('outbox insert failed'),
      );
      const eventFactory = jest
        .fn()
        .mockReturnValue({ eventType: 'order.status_changed', payload: {} });

      await expect(repository.save(order, eventFactory)).rejects.toThrow(
        'outbox insert failed',
      );
    });
  });
});
