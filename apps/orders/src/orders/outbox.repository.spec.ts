import { EntityManager, Repository } from 'typeorm';
import { OutboxRepository } from './outbox.repository';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxEventStatus } from './outbox.constants';

describe('OutboxRepository', () => {
  let repository: jest.Mocked<Pick<Repository<OutboxEvent>, 'find' | 'update'>>;
  let outboxRepository: OutboxRepository;

  const buildRow = (overrides: Partial<OutboxEvent> = {}): OutboxEvent =>
    ({
      id: 'evt-1',
      eventType: 'order.status_changed',
      payload: { orderId: 'order-1' },
      status: OutboxEventStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
      lastAttemptAt: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as OutboxEvent;

  beforeEach(() => {
    repository = {
      find: jest.fn(),
      update: jest.fn(),
    };
    outboxRepository = new OutboxRepository(
      repository as unknown as Repository<OutboxEvent>,
    );
  });

  describe('insertWithin', () => {
    it('creates and saves the outbox row through the given manager (transactional insert)', async () => {
      const created = { eventType: 'order.status_changed', payload: { a: 1 } };
      const saved = buildRow({ payload: { a: 1 } });
      const managerRepo = {
        create: jest.fn().mockReturnValue(created),
        save: jest.fn().mockResolvedValue(saved),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue(managerRepo),
      } as unknown as EntityManager;

      const result = await outboxRepository.insertWithin(manager, {
        eventType: 'order.status_changed',
        payload: { a: 1 },
      });

      expect(manager.getRepository).toHaveBeenCalledWith(OutboxEvent);
      expect(managerRepo.create).toHaveBeenCalledWith({
        eventType: 'order.status_changed',
        payload: { a: 1 },
      });
      expect(managerRepo.save).toHaveBeenCalledWith(created);
      expect(result).toBe(saved);
    });
  });

  describe('claimDue', () => {
    it('queries pending rows whose nextAttemptAt is due, oldest first, limited to batchSize', async () => {
      const due = [buildRow()];
      repository.find.mockResolvedValue(due);

      const result = await outboxRepository.claimDue(20);

      expect(repository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OutboxEventStatus.PENDING }),
          order: { createdAt: 'ASC' },
          take: 20,
        }),
      );
      expect(result).toBe(due);
    });
  });

  describe('markAttempt', () => {
    it('increments attempts, stamps lastAttemptAt and schedules nextAttemptAt using backoff from the new attempt count', async () => {
      const row = buildRow({ attempts: 0 });

      await outboxRepository.markAttempt(row, 1000, 60000);

      expect(repository.update).toHaveBeenCalledWith(
        row.id,
        expect.objectContaining({ attempts: 1 }),
      );
      const [, payload] = repository.update.mock.calls[0];
      const scheduled = payload.nextAttemptAt as Date;
      const attemptedAt = payload.lastAttemptAt as Date;
      expect(scheduled.getTime() - attemptedAt.getTime()).toBe(1000);
      expect(row.attempts).toBe(1);
    });

    it('applies a larger backoff on a later attempt (triangulation: attempts=3 doubles twice)', async () => {
      const row = buildRow({ attempts: 2 });

      await outboxRepository.markAttempt(row, 1000, 60000);

      const [, payload] = repository.update.mock.calls[0];
      const scheduled = payload.nextAttemptAt as Date;
      const attemptedAt = payload.lastAttemptAt as Date;
      expect(scheduled.getTime() - attemptedAt.getTime()).toBe(4000);
      expect(row.attempts).toBe(3);
    });
  });

  describe('markSent', () => {
    it('marks the row sent and stamps sentAt', async () => {
      await outboxRepository.markSent('evt-1');

      expect(repository.update).toHaveBeenCalledWith(
        'evt-1',
        expect.objectContaining({ status: OutboxEventStatus.SENT }),
      );
      const [, payload] = repository.update.mock.calls[0];
      expect(payload.sentAt).toBeInstanceOf(Date);
    });
  });

  describe('markError', () => {
    it('keeps the row pending (retryable) when attempts have not reached the max', async () => {
      await outboxRepository.markError('evt-1', 2, 10, new Error('boom'));

      expect(repository.update).toHaveBeenCalledWith('evt-1', {
        status: OutboxEventStatus.PENDING,
        lastError: 'boom',
      });
    });

    it('marks the row failed once attempts reach the configured max (triangulation)', async () => {
      await outboxRepository.markError('evt-1', 10, 10, new Error('down'));

      expect(repository.update).toHaveBeenCalledWith('evt-1', {
        status: OutboxEventStatus.FAILED,
        lastError: 'down',
      });
    });

    it('truncates lastError to 1000 chars', async () => {
      const longMessage = 'x'.repeat(1500);

      await outboxRepository.markError('evt-1', 1, 10, new Error(longMessage));

      const [, payload] = repository.update.mock.calls[0];
      expect((payload.lastError as string).length).toBe(1000);
    });
  });
});
