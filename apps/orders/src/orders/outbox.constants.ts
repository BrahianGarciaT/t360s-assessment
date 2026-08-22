export enum OutboxEventStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

export interface OutboxConfig {
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  sendTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  purgeRetentionDays: number;
}

const DEFAULT_OUTBOX_CONFIG: OutboxConfig = {
  pollIntervalMs: 2000,
  batchSize: 20,
  maxAttempts: 10,
  sendTimeoutMs: 5000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
  purgeRetentionDays: 30,
};

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Construye la configuración del outbox poller a partir de variables de
 * entorno, recurriendo a los valores por defecto documentados cuando faltan
 * o son inválidos.
 */
export function getOutboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): OutboxConfig {
  return {
    pollIntervalMs: parseIntEnv(
      env.OUTBOX_POLL_INTERVAL_MS,
      DEFAULT_OUTBOX_CONFIG.pollIntervalMs,
    ),
    batchSize: parseIntEnv(
      env.OUTBOX_BATCH_SIZE,
      DEFAULT_OUTBOX_CONFIG.batchSize,
    ),
    maxAttempts: parseIntEnv(
      env.OUTBOX_MAX_ATTEMPTS,
      DEFAULT_OUTBOX_CONFIG.maxAttempts,
    ),
    sendTimeoutMs: parseIntEnv(
      env.OUTBOX_SEND_TIMEOUT_MS,
      DEFAULT_OUTBOX_CONFIG.sendTimeoutMs,
    ),
    backoffBaseMs: parseIntEnv(
      env.OUTBOX_BACKOFF_BASE_MS,
      DEFAULT_OUTBOX_CONFIG.backoffBaseMs,
    ),
    backoffMaxMs: parseIntEnv(
      env.OUTBOX_BACKOFF_MAX_MS,
      DEFAULT_OUTBOX_CONFIG.backoffMaxMs,
    ),
    purgeRetentionDays: parseIntEnv(
      env.OUTBOX_PURGE_RETENTION_DAYS,
      DEFAULT_OUTBOX_CONFIG.purgeRetentionDays,
    ),
  };
}

/**
 * Backoff exponencial, limitado a `maxMs`: base * 2^(attempts-1).
 * attempts=1 -> base, attempts=2 -> 2*base, ... hasta alcanzar el límite.
 */
export function calculateBackoffMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponent = Math.max(attempts - 1, 0);
  const exponential = baseMs * Math.pow(2, exponent);
  return Math.min(exponential, maxMs);
}
