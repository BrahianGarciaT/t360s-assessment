export const AUDIT_TCP_CLIENT = 'AUDIT_TCP_CLIENT';
export const INVENTORY_TCP_CLIENT = 'INVENTORY_TCP_CLIENT';

export interface InventoryClientConfig {
  sendTimeoutMs: number;
}

const DEFAULT_INVENTORY_CLIENT_CONFIG: InventoryClientConfig = {
  sendTimeoutMs: 3000,
};

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Builds the `INVENTORY_TCP_CLIENT` send-timeout configuration from
 * environment variables, falling back to the documented default when
 * missing or invalid. Clone of `getOutboxConfig()`'s `parseIntEnv` idiom
 * (`outbox.constants.ts`), tighter than `OUTBOX_SEND_TIMEOUT_MS` because
 * this call sits in the user-facing `POST /orders` request path.
 */
export function getInventoryClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): InventoryClientConfig {
  return {
    sendTimeoutMs: parseIntEnv(
      env.INVENTORY_SEND_TIMEOUT_MS,
      DEFAULT_INVENTORY_CLIENT_CONFIG.sendTimeoutMs,
    ),
  };
}
