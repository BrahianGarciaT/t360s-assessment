import { AxiosInstance } from 'axios';

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  description?: string;
}

const DEFAULT_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `check` until it returns a truthy value or `timeoutMs` elapses.
 * Used instead of a fixed `setTimeout` because the outbox poller's own
 * delivery latency is not a constant (it depends on `OUTBOX_POLL_INTERVAL_MS`
 * and backoff), so a hardcoded sleep is either flaky or wastefully slow.
 */
export async function waitUntil<T>(
  check: () => Promise<T | undefined | null | false>,
  options: WaitOptions,
): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${options.timeoutMs}ms waiting for: ${
          options.description ?? 'condition'
        }`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Polls `GET /audit/:orderId` until it returns exactly `expectedCount`
 * records (200 with a matching array length). Tolerates `audit` being
 * temporarily unreachable (ECONNREFUSED / non-200) between attempts.
 */
export async function waitForAuditLogs(
  auditApi: AxiosInstance,
  orderId: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<unknown[]> {
  return waitUntil(
    async () => {
      const res = await auditApi.get(`/audit/${orderId}`);
      if (res.status === 200 && Array.isArray(res.data)) {
        return res.data.length === expectedCount ? res.data : false;
      }
      return false;
    },
    {
      timeoutMs,
      description: `GET /audit/${orderId} to return ${expectedCount} record(s)`,
    },
  );
}
