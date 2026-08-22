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

    expect(config).toEqual({ sendTimeoutMs: 3000 });
  });

  it('uses the value from INVENTORY_SEND_TIMEOUT_MS when present and valid', () => {
    const config = getInventoryClientConfig({
      INVENTORY_SEND_TIMEOUT_MS: '1200',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({ sendTimeoutMs: 1200 });
  });

  it('ignores a non-numeric or non-positive value and keeps the default', () => {
    const config = getInventoryClientConfig({
      INVENTORY_SEND_TIMEOUT_MS: '-100',
    } as NodeJS.ProcessEnv);

    expect(config.sendTimeoutMs).toBe(3000);
  });
});
