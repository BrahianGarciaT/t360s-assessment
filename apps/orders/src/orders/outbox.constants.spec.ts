import {
  calculateBackoffMs,
  getOutboxConfig,
  OutboxEventStatus,
} from './outbox.constants';

describe('OutboxEventStatus', () => {
  it('exposes pending, sent and failed states as lowercase wire values', () => {
    expect(OutboxEventStatus.PENDING).toBe('pending');
    expect(OutboxEventStatus.SENT).toBe('sent');
    expect(OutboxEventStatus.FAILED).toBe('failed');
  });
});

describe('calculateBackoffMs', () => {
  it('returns the base delay unchanged on the first attempt', () => {
    expect(calculateBackoffMs(1, 1000, 60000)).toBe(1000);
  });

  it('doubles the delay for each subsequent attempt', () => {
    expect(calculateBackoffMs(2, 1000, 60000)).toBe(2000);
    expect(calculateBackoffMs(3, 1000, 60000)).toBe(4000);
    expect(calculateBackoffMs(6, 1000, 60000)).toBe(32000);
  });

  it('caps the delay at the configured maximum', () => {
    expect(calculateBackoffMs(7, 1000, 60000)).toBe(60000);
    expect(calculateBackoffMs(20, 1000, 60000)).toBe(60000);
  });
});

describe('getOutboxConfig', () => {
  it('falls back to documented defaults when no env vars are set', () => {
    const config = getOutboxConfig({});

    expect(config).toEqual({
      pollIntervalMs: 2000,
      batchSize: 20,
      maxAttempts: 10,
      sendTimeoutMs: 5000,
      backoffBaseMs: 1000,
      backoffMaxMs: 60000,
    });
  });

  it('uses values from env vars when present and valid', () => {
    const config = getOutboxConfig({
      OUTBOX_POLL_INTERVAL_MS: '500',
      OUTBOX_BATCH_SIZE: '5',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_SEND_TIMEOUT_MS: '1500',
      OUTBOX_BACKOFF_BASE_MS: '250',
      OUTBOX_BACKOFF_MAX_MS: '9000',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      pollIntervalMs: 500,
      batchSize: 5,
      maxAttempts: 3,
      sendTimeoutMs: 1500,
      backoffBaseMs: 250,
      backoffMaxMs: 9000,
    });
  });

  it('ignores non-numeric or non-positive env values and keeps defaults', () => {
    const config = getOutboxConfig({
      OUTBOX_BATCH_SIZE: 'not-a-number',
      OUTBOX_MAX_ATTEMPTS: '-5',
    } as NodeJS.ProcessEnv);

    expect(config.batchSize).toBe(20);
    expect(config.maxAttempts).toBe(10);
  });
});
