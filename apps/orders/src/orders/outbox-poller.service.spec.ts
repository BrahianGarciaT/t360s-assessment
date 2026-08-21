import { of, throwError } from 'rxjs';
import { INVENTORY_EVENTS, INVENTORY_PATTERNS } from '@app/shared';
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
  let inventoryClient: { send: jest.Mock; close: jest.Mock };
  let logger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock };

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
    inventoryClient = {
      send: jest.fn(),
      close: jest.fn(),
    };
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    poller = new OutboxPollerService(
      outboxRepository as unknown as OutboxRepository,
      auditClient as never,
      inventoryClient as never,
      logger as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when there are no due events', async () => {
    outboxRepository.claimDue.mockResolvedValue([]);

    await poller.tick();

    expect(auditClient.send).not.toHaveBeenCalled();
    expect(inventoryClient.send).not.toHaveBeenCalled();
    expect(outboxRepository.markAttempt).not.toHaveBeenCalled();
  });

  it('routes an order.* event to the audit client using the eventType as the pattern', async () => {
    const row = buildRow({ eventType: 'order.status_changed' });
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
    expect(inventoryClient.send).not.toHaveBeenCalled();
  });

  it('routes an inventory.commit_requested event to the inventory client, translated to the inventory.commit TCP pattern', async () => {
    const row = buildRow({
      id: 'evt-commit',
      eventType: INVENTORY_EVENTS.COMMIT_REQUESTED,
      payload: { orderId: 'order-1' },
    });
    outboxRepository.claimDue.mockResolvedValue([row]);
    inventoryClient.send.mockReturnValue(of({ ok: true, orderId: 'order-1' }));

    await poller.tick();

    expect(inventoryClient.send).toHaveBeenCalledWith(
      INVENTORY_PATTERNS.COMMIT,
      { eventId: row.id, ...row.payload },
    );
    expect(outboxRepository.markSent).toHaveBeenCalledWith(row.id);
    expect(auditClient.send).not.toHaveBeenCalled();
  });

  it('routes an inventory.release_requested event to the inventory client, translated to the inventory.release TCP pattern (triangulation)', async () => {
    const row = buildRow({
      id: 'evt-release',
      eventType: INVENTORY_EVENTS.RELEASE_REQUESTED,
      payload: { orderId: 'order-2' },
    });
    outboxRepository.claimDue.mockResolvedValue([row]);
    inventoryClient.send.mockReturnValue(of({ ok: true, orderId: 'order-2' }));

    await poller.tick();

    expect(inventoryClient.send).toHaveBeenCalledWith(
      INVENTORY_PATTERNS.RELEASE,
      { eventId: row.id, ...row.payload },
    );
    expect(outboxRepository.markSent).toHaveBeenCalledWith(row.id);
  });

  it('marks an unroutable eventType as errored without attempting delivery on any client', async () => {
    const row = buildRow({ eventType: 'unknown.mystery_event' });
    outboxRepository.claimDue.mockResolvedValue([row]);

    await poller.tick();

    expect(auditClient.send).not.toHaveBeenCalled();
    expect(inventoryClient.send).not.toHaveBeenCalled();
    expect(outboxRepository.markError).toHaveBeenCalledWith(
      row.id,
      expect.any(Number),
      expect.any(Number),
      expect.any(Error),
    );
  });

  it('isolates a failed destination: an audit failure closes only auditClient and still delivers a same-tick inventory row', async () => {
    const auditRowA = buildRow({
      id: 'evt-a',
      eventType: 'order.status_changed',
    });
    const auditRowB = buildRow({
      id: 'evt-b',
      eventType: 'order.status_changed',
    });
    const inventoryRow = buildRow({
      id: 'evt-c',
      eventType: INVENTORY_EVENTS.COMMIT_REQUESTED,
      payload: { orderId: 'order-3' },
    });
    outboxRepository.claimDue.mockResolvedValue([
      auditRowA,
      auditRowB,
      inventoryRow,
    ]);
    auditClient.send.mockReturnValue(throwError(() => new Error('audit down')));
    inventoryClient.send.mockReturnValue(of({ ok: true, orderId: 'order-3' }));

    await poller.tick();

    // first audit row: attempted and errored
    expect(outboxRepository.markError).toHaveBeenCalledWith(
      auditRowA.id,
      1,
      expect.any(Number),
      expect.any(Error),
    );
    expect(auditClient.close).toHaveBeenCalledTimes(1);
    expect(auditClient.send).toHaveBeenCalledTimes(1); // second audit row skipped (continue, not break)

    // inventory row in the SAME tick was still delivered — the audit failure
    // never stalls a different destination
    expect(inventoryClient.send).toHaveBeenCalledTimes(1);
    expect(outboxRepository.markSent).toHaveBeenCalledWith(inventoryRow.id);
    expect(inventoryClient.close).not.toHaveBeenCalled();
  });

  it('isolates a failed destination: an inventory failure closes only inventoryClient and still delivers a same-tick audit row (triangulation)', async () => {
    const inventoryRowA = buildRow({
      id: 'evt-inv-a',
      eventType: INVENTORY_EVENTS.RELEASE_REQUESTED,
      payload: { orderId: 'order-4' },
    });
    const inventoryRowB = buildRow({
      id: 'evt-inv-b',
      eventType: INVENTORY_EVENTS.RELEASE_REQUESTED,
      payload: { orderId: 'order-5' },
    });
    const auditRow = buildRow({
      id: 'evt-audit',
      eventType: 'order.status_changed',
    });
    outboxRepository.claimDue.mockResolvedValue([
      inventoryRowA,
      inventoryRowB,
      auditRow,
    ]);
    inventoryClient.send.mockReturnValue(
      throwError(() => new Error('inventory down')),
    );
    auditClient.send.mockReturnValue(of({ ok: true, eventId: auditRow.id }));

    await poller.tick();

    expect(inventoryClient.close).toHaveBeenCalledTimes(1);
    expect(inventoryClient.send).toHaveBeenCalledTimes(1); // second inventory row skipped

    expect(auditClient.send).toHaveBeenCalledTimes(1);
    expect(outboxRepository.markSent).toHaveBeenCalledWith(auditRow.id);
    expect(auditClient.close).not.toHaveBeenCalled();
  });

  it('does not let a throwing client.close() escape tick() as an unhandled rejection', async () => {
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
