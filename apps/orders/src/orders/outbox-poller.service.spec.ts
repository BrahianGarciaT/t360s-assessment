import { of, throwError } from 'rxjs';
import { OutboxPollerService } from './outbox-poller.service';
import { OutboxRepository } from './outbox.repository';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxEventStatus } from './outbox.constants';

describe('OutboxPollerService', () => {
  let poller: OutboxPollerService;
  let outboxRepository: jest.Mocked<
    Pick<
      OutboxRepository,
      'claimDue' | 'markAttempt' | 'markSent' | 'markError'
    >
  >;
  let auditClient: { send: jest.Mock; close: jest.Mock };

  const buildRow = (overrides: Partial<OutboxEvent> = {}): OutboxEvent =>
    ({
      id: 'evt-1',
      eventType: 'order.status_changed',
      payload: { orderId: 'order-1', toStatus: 'PENDING' },
      status: OutboxEventStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date(),
      lastAttemptAt: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date(),
      ...overrides,
    }) as OutboxEvent;

  beforeEach(() => {
    outboxRepository = {
      claimDue: jest.fn(),
      markAttempt: jest.fn().mockImplementation(async (row: OutboxEvent) => {
        row.attempts += 1;
      }),
      markSent: jest.fn(),
      markError: jest.fn(),
    };
    auditClient = {
      send: jest.fn(),
      close: jest.fn(),
    };

    poller = new OutboxPollerService(
      outboxRepository as unknown as OutboxRepository,
      auditClient as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when there are no due events', async () => {
    outboxRepository.claimDue.mockResolvedValue([]);

    await poller.tick();

    expect(auditClient.send).not.toHaveBeenCalled();
    expect(outboxRepository.markAttempt).not.toHaveBeenCalled();
  });

  it('marks an attempt before sending, delivers the event, and marks it sent on success', async () => {
    const row = buildRow();
    outboxRepository.claimDue.mockResolvedValue([row]);
    auditClient.send.mockReturnValue(of({ ok: true, eventId: row.id }));

    await poller.tick();

    expect(outboxRepository.markAttempt).toHaveBeenCalledWith(
      row,
      expect.any(Number),
      expect.any(Number),
    );
    expect(auditClient.send).toHaveBeenCalledWith(row.eventType, {
      eventId: row.id,
      ...row.payload,
    });
    // markAttempt must run BEFORE send — a crash mid-send reschedules instead of hot-looping
    const attemptOrder =
      outboxRepository.markAttempt.mock.invocationCallOrder[0];
    const sendOrder = auditClient.send.mock.invocationCallOrder[0];
    expect(attemptOrder).toBeLessThan(sendOrder);

    expect(outboxRepository.markSent).toHaveBeenCalledWith(row.id);
    expect(outboxRepository.markError).not.toHaveBeenCalled();
    expect(auditClient.close).not.toHaveBeenCalled();
  });

  it('marks the event errored, closes the client and stops processing further rows on the first failure (break)', async () => {
    const rowA = buildRow({ id: 'evt-a' });
    const rowB = buildRow({ id: 'evt-b' });
    outboxRepository.claimDue.mockResolvedValue([rowA, rowB]);
    auditClient.send.mockReturnValue(throwError(() => new Error('audit down')));

    await poller.tick();

    expect(outboxRepository.markError).toHaveBeenCalledWith(
      rowA.id,
      1, // attempts after markAttempt bumped it
      expect.any(Number),
      expect.any(Error),
    );
    expect(auditClient.close).toHaveBeenCalledTimes(1);
    // break: the second row must never be attempted
    expect(auditClient.send).toHaveBeenCalledTimes(1);
    expect(outboxRepository.markAttempt).toHaveBeenCalledTimes(1);
    expect(outboxRepository.markSent).not.toHaveBeenCalled();
  });

  it('does not let a throwing auditClient.close() escape tick() as an unhandled rejection', async () => {
    const row = buildRow();
    outboxRepository.claimDue.mockResolvedValue([row]);
    auditClient.send.mockReturnValue(throwError(() => new Error('audit down')));
    auditClient.close.mockImplementation(() => {
      throw new Error('close() blew up');
    });

    // If tick() lets this escape, this await itself would reject — that's
    // the failure mode this test guards against (an unhandled rejection
    // from a scheduled tick would otherwise crash the whole process).
    await expect(poller.tick()).resolves.toBeUndefined();

    expect(auditClient.close).toHaveBeenCalledTimes(1);
    expect(outboxRepository.markError).toHaveBeenCalledWith(
      row.id,
      1,
      expect.any(Number),
      expect.any(Error),
    );
  });

  it('passes the configured max attempts through to markError so the repository can cap to failed (triangulation)', async () => {
    const row = buildRow({ attempts: 9 });
    outboxRepository.claimDue.mockResolvedValue([row]);
    auditClient.send.mockReturnValue(throwError(() => new Error('still down')));

    await poller.tick();

    expect(outboxRepository.markError).toHaveBeenCalledWith(
      row.id,
      10,
      10, // default OUTBOX_MAX_ATTEMPTS
      expect.any(Error),
    );
  });

  it('ignores an overlapping tick while a previous one is still running (re-entrancy guard)', async () => {
    let resolveClaim!: (rows: OutboxEvent[]) => void;
    const pending = new Promise<OutboxEvent[]>((resolve) => {
      resolveClaim = resolve;
    });
    outboxRepository.claimDue.mockReturnValueOnce(pending);

    const firstTick = poller.tick();
    const secondTick = poller.tick();

    resolveClaim([]);
    await Promise.all([firstTick, secondTick]);

    expect(outboxRepository.claimDue).toHaveBeenCalledTimes(1);
  });

  it('allows a new tick to run again once the previous one finished (guard resets)', async () => {
    outboxRepository.claimDue.mockResolvedValue([]);

    await poller.tick();
    await poller.tick();

    expect(outboxRepository.claimDue).toHaveBeenCalledTimes(2);
  });
});
