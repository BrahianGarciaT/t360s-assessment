import {
  AUDIT_TCP_CLIENT,
  getInventoryClientConfig,
  INVENTORY_TCP_CLIENT,
} from './orders.constants';

describe('AUDIT_TCP_CLIENT / INVENTORY_TCP_CLIENT tokens', () => {
  it('exposes distinct DI tokens for each TCP client', () => {
    expect(AUDIT_TCP_CLIENT).toBe('AUDIT_TCP_CLIENT');
    expect(INVENTORY_TCP_CLIENT).toBe('INVENTORY_TCP_CLIENT');
  });
});

describe('getInventoryClientConfig', () => {
  it('falls back to the documented default send timeout when no env var is set', () => {
    const config = getInventoryClientConfig({});

    expect(config).toEqual({
      sendTimeoutMs: 3000,
      breakerFailureThreshold: 5,
      breakerResetTimeoutMs: 15000,
    });
  });

  it('uses the value from INVENTORY_SEND_TIMEOUT_MS when present and valid', () => {
    const config = getInventoryClientConfig({
      INVENTORY_SEND_TIMEOUT_MS: '1200',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      sendTimeoutMs: 1200,
      breakerFailureThreshold: 5,
      breakerResetTimeoutMs: 15000,
    });
  });

  it('ignores a non-numeric or non-positive value and keeps the default', () => {
    const config = getInventoryClientConfig({
      INVENTORY_SEND_TIMEOUT_MS: '-100',
    } as NodeJS.ProcessEnv);

    expect(config.sendTimeoutMs).toBe(3000);
  });

  it('falls back to the documented default breaker failure threshold when no env var is set', () => {
    const config = getInventoryClientConfig({});

    expect(config.breakerFailureThreshold).toBe(5);
  });

  it('uses the value from INVENTORY_BREAKER_FAILURE_THRESHOLD when present and valid', () => {
    const config = getInventoryClientConfig({
      INVENTORY_BREAKER_FAILURE_THRESHOLD: '8',
    } as NodeJS.ProcessEnv);

    expect(config.breakerFailureThreshold).toBe(8);
  });

  it('ignores a non-numeric or non-positive INVENTORY_BREAKER_FAILURE_THRESHOLD and keeps the default', () => {
    const config = getInventoryClientConfig({
      INVENTORY_BREAKER_FAILURE_THRESHOLD: '-1',
    } as NodeJS.ProcessEnv);

    expect(config.breakerFailureThreshold).toBe(5);
  });

  it('falls back to the documented default breaker reset timeout when no env var is set', () => {
    const config = getInventoryClientConfig({});

    expect(config.breakerResetTimeoutMs).toBe(15000);
  });

  it('uses the value from INVENTORY_BREAKER_RESET_TIMEOUT_MS when present and valid', () => {
    const config = getInventoryClientConfig({
      INVENTORY_BREAKER_RESET_TIMEOUT_MS: '20000',
    } as NodeJS.ProcessEnv);

    expect(config.breakerResetTimeoutMs).toBe(20000);
  });

  it('ignores a non-numeric or non-positive INVENTORY_BREAKER_RESET_TIMEOUT_MS and keeps the default', () => {
    const config = getInventoryClientConfig({
      INVENTORY_BREAKER_RESET_TIMEOUT_MS: '0',
    } as NodeJS.ProcessEnv);

    expect(config.breakerResetTimeoutMs).toBe(15000);
  });
});
