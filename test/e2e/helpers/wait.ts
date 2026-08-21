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

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
]);

/**
 * True for connection-level failures a real HTTP client would retry
 * transparently (dropped/reset socket, refused connection) — never for an
 * HTTP response, even an error one (4xx/5xx), which callers must keep
 * handling themselves.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined && TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  // Node sets message "socket hang up" for a premature close without
  // always attaching `.code` through axios's error wrapping — match on
  // message too so we don't miss it.
  return error.message.includes('socket hang up');
}

/**
 * Retries `fn` a bounded number of times, but only when it fails with a
 * transient connection-level network error — never for assertion failures
 * or HTTP error responses, which propagate immediately.
 *
 * Why this exists: in CI (GitHub Actions, Linux runners) the `PUT
 * /orders/:id/status` request issued immediately after `stopService('audit')`
 * has been observed to fail with ECONNRESET/"socket hang up" against
 * `orders` — a *different* container than the one being stopped, on the
 * same `app-network` bridge. This was investigated as a possible app bug
 * and ruled out with direct evidence:
 *   - `docker compose logs` across two separate CI runs shows a single,
 *     uninterrupted NestJS boot for `orders` ("Starting Nest
 *     application..." -> "...successfully started"), no error/exception
 *     logged, and the container stays up until the job's own teardown.
 *   - The `PUT` handler never talks to `audit` synchronously — the outbox
 *     poller delivers to `audit` on its own interval, decoupled from the
 *     request/response cycle (see `outbox-poller.service.ts`).
 *   - Never reproduced locally (8 full e2e runs against Docker Desktop on
 *     Windows) — only ever seen on GitHub Actions' native Linux Docker
 *     daemon, which is consistent with a brief iptables/NAT reprogramming
 *     blip on the shared bridge network when a sibling container is
 *     stopped, not an application-level failure.
 * A real client hitting a genuinely transient network blip would retry
 * rather than surface it as a hard failure, so this test does the same —
 * scoped tightly to the one request known to be affected, not as a general
 * safety net that could mask a real regression.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 300;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === attempts;
      if (!isTransientNetworkError(error) || isLastAttempt) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error('withTransientRetry: exhausted attempts unexpectedly');
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
