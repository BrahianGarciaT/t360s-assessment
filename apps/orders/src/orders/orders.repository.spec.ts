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
  let orderManagerRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };

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
    orderManagerRepo = { create: jest.fn(), save: jest.fn(), findOne: jest.fn() };
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
      // base repository usado solo por las lecturas no transaccionales de
      // findAll/findById/save, no se ejerce en los paths transaccionales
      // que se testean acá
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
        .mockReturnValue([{ eventType: 'order.status_changed', payload: {} }]);

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
      expect(outboxRepository.insertWithin).toHaveBeenCalledTimes(1);
      expect(outboxRepository.insertWithin).toHaveBeenCalledWith(manager, {
        eventType: 'order.status_changed',
        payload: {},
      });
      expect(result).toBe(saved);
    });

    it('inserts every event the factory returns, in order, within the same transaction (triangulation)', async () => {
      const data = { userId: 'user-1', status: OrderStatus.PENDING };
      const saved = buildOrder();
      orderManagerRepo.create.mockReturnValue(data);
      orderManagerRepo.save.mockResolvedValue(saved);
      outboxRepository.insertWithin.mockResolvedValue({} as OutboxEvent);
      const eventFactory = jest.fn().mockReturnValue([
        { eventType: 'order.status_changed', payload: { a: 1 } },
        { eventType: 'inventory.commit_requested', payload: { b: 2 } },
      ]);

      await repository.create(data, eventFactory);

      expect(outboxRepository.insertWithin).toHaveBeenCalledTimes(2);
      expect(outboxRepository.insertWithin).toHaveBeenNthCalledWith(
        1,
        manager,
        { eventType: 'order.status_changed', payload: { a: 1 } },
      );
      expect(outboxRepository.insertWithin).toHaveBeenNthCalledWith(
        2,
        manager,
        { eventType: 'inventory.commit_requested', payload: { b: 2 } },
      );
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
        .mockReturnValue([{ eventType: 'order.status_changed', payload: {} }]);

      await expect(repository.create(data, eventFactory)).rejects.toThrow(
        'outbox insert failed',
      );
      // prueba que el callback de la transacción propagó la falla en vez de
      // tragársela — dataSource.transaction() hace rollback ante un rechazo
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('transitionStatus', () => {
    it('reads the order with a pessimistic write lock, persists the transition, refreshes the search vector, and inserts the outbox event within one transaction', async () => {
      const order = buildOrder({ status: OrderStatus.CONFIRMED });
      orderManagerRepo.findOne.mockResolvedValue(order);
      orderManagerRepo.save.mockResolvedValue(order);
      outboxRepository.insertWithin.mockResolvedValue({} as OutboxEvent);
      const buildEvents = jest
        .fn()
        .mockReturnValue([{ eventType: 'order.status_changed', payload: {} }]);
      const transition = jest.fn().mockReturnValue(buildEvents);

      const result = await repository.transitionStatus(order.id, transition);

      expect(orderManagerRepo.findOne).toHaveBeenCalledWith({
        where: { id: order.id },
        lock: { mode: 'pessimistic_write' },
      });
      expect(transition).toHaveBeenCalledWith(order);
      expect(orderManagerRepo.save).toHaveBeenCalledWith(order);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders'),
        [order.id],
      );
      expect(buildEvents).toHaveBeenCalledWith(order);
      expect(outboxRepository.insertWithin).toHaveBeenCalledTimes(1);
      expect(outboxRepository.insertWithin).toHaveBeenCalledWith(manager, {
        eventType: 'order.status_changed',
        payload: {},
      });
      expect(result).toBe(order);
    });

    it('inserts both the order.status_changed and the inventory finalize event on a CONFIRMED transition (triangulation)', async () => {
      const order = buildOrder({ status: OrderStatus.CONFIRMED });
      orderManagerRepo.findOne.mockResolvedValue(order);
      orderManagerRepo.save.mockResolvedValue(order);
      outboxRepository.insertWithin.mockResolvedValue({} as OutboxEvent);
      const buildEvents = jest.fn().mockReturnValue([
        { eventType: 'order.status_changed', payload: {} },
        { eventType: 'inventory.commit_requested', payload: {} },
      ]);
      const transition = jest.fn().mockReturnValue(buildEvents);

      await repository.transitionStatus(order.id, transition);

      expect(outboxRepository.insertWithin).toHaveBeenCalledTimes(2);
      expect(outboxRepository.insertWithin).toHaveBeenNthCalledWith(
        2,
        manager,
        { eventType: 'inventory.commit_requested', payload: {} },
      );
    });

    it('rolls back the whole transaction when the outbox insert fails on a status update (triangulation)', async () => {
      const order = buildOrder({ status: OrderStatus.SHIPPED });
      orderManagerRepo.findOne.mockResolvedValue(order);
      orderManagerRepo.save.mockResolvedValue(order);
      outboxRepository.insertWithin.mockRejectedValue(
        new Error('outbox insert failed'),
      );
      const buildEvents = jest
        .fn()
        .mockReturnValue([{ eventType: 'order.status_changed', payload: {} }]);
      const transition = jest.fn().mockReturnValue(buildEvents);

      await expect(
        repository.transitionStatus(order.id, transition),
      ).rejects.toThrow('outbox insert failed');
    });

    it('returns null without saving, refreshing the search vector, inserting events, or invoking the transition callback when the locked row does not exist', async () => {
      orderManagerRepo.findOne.mockResolvedValue(null);
      const transition = jest.fn();

      const result = await repository.transitionStatus(
        'missing-id',
        transition,
      );

      expect(result).toBeNull();
      expect(transition).not.toHaveBeenCalled();
      expect(orderManagerRepo.save).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      expect(outboxRepository.insertWithin).not.toHaveBeenCalled();
    });

    it('propagates the error and never saves when the transition callback throws (e.g. an invalid FSM transition)', async () => {
      const order = buildOrder({ status: OrderStatus.DELIVERED });
      orderManagerRepo.findOne.mockResolvedValue(order);
      const transition = jest.fn().mockImplementation(() => {
        throw new Error('Cannot transition from DELIVERED to PENDING');
      });

      await expect(
        repository.transitionStatus(order.id, transition),
      ).rejects.toThrow('Cannot transition from DELIVERED to PENDING');
      expect(orderManagerRepo.save).not.toHaveBeenCalled();
      expect(outboxRepository.insertWithin).not.toHaveBeenCalled();
    });
  });
});
