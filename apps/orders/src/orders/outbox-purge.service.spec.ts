import { OutboxPurgeService } from './outbox-purge.service';
import { OutboxRepository } from './outbox.repository';

describe('OutboxPurgeService', () => {
  let purgeService: OutboxPurgeService;
  let outboxRepository: jest.Mocked<
    Pick<OutboxRepository, 'deleteSentOlderThan'>
  >;
  let logger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock };

  beforeEach(() => {
    outboxRepository = {
      deleteSentOlderThan: jest.fn(),
    };
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    };

    purgeService = new OutboxPurgeService(
      outboxRepository as unknown as OutboxRepository,
      logger as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('deletes sent rows older than the configured retention window (default 30 days)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
    outboxRepository.deleteSentOlderThan.mockResolvedValue(0);

    await purgeService.purge();

    const [cutoff] = outboxRepository.deleteSentOlderThan.mock.calls[0] as [
      Date,
    ];
    expect(cutoff.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it('logs the deleted count when rows were purged', async () => {
    outboxRepository.deleteSentOlderThan.mockResolvedValue(5);

    await purgeService.purge();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 5 }),
      expect.any(String),
    );
  });

  it('stays quiet when nothing was purged', async () => {
    outboxRepository.deleteSentOlderThan.mockResolvedValue(0);

    await purgeService.purge();

    expect(logger.info).not.toHaveBeenCalled();
  });
});
