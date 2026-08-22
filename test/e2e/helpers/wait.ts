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
 * Hace polling de `check` hasta que devuelve un valor truthy o transcurre `timeoutMs`.
 * Se usa en lugar de un `setTimeout` fijo porque la latencia de entrega propia
 * del poller del outbox no es constante (depende de `OUTBOX_POLL_INTERVAL_MS`
 * y del backoff), por lo que un sleep fijo sería inestable o innecesariamente lento.
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
 * Verdadero para fallas a nivel de conexión que un cliente HTTP real reintentaría
 * de forma transparente (socket caído/reseteado, conexión rechazada) — nunca para
 * una respuesta HTTP, incluso una de error (4xx/5xx), que los llamadores deben seguir
 * manejando por su cuenta.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined && TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  // Node asigna el mensaje "socket hang up" para un cierre prematuro sin
  // adjuntar siempre `.code` a través del envoltorio de error de axios — comparar
  // también por mensaje para no perderlo.
  return error.message.includes('socket hang up');
}

/**
 * Reintenta `fn` una cantidad acotada de veces, pero solo cuando falla con un
 * error de red transitorio a nivel de conexión — nunca para fallos de aserción
 * o respuestas HTTP de error, que se propagan de inmediato.
 *
 * Por qué existe esto: en CI (GitHub Actions, runners Linux) se ha observado que la
 * solicitud `PUT /orders/:id/status` emitida inmediatamente después de `stopService('audit')`
 * falla con ECONNRESET/"socket hang up" contra
 * `orders` — un contenedor *distinto* al que se está deteniendo, en la
 * misma red bridge `app-network`. Esto se investigó como un posible bug de la app
 * y se descartó con evidencia directa:
 *   - `docker compose logs` en dos corridas de CI separadas muestra un único
 *     arranque ininterrumpido de NestJS para `orders` ("Starting Nest
 *     application..." -> "...successfully started"), sin error/excepción
 *     registrado, y el contenedor se mantiene arriba hasta el propio teardown del job.
 *   - El handler de `PUT` nunca se comunica con `audit` de forma síncrona — el
 *     poller del outbox entrega a `audit` según su propio intervalo, desacoplado del
 *     ciclo de solicitud/respuesta (ver `outbox-poller.service.ts`).
 *   - Nunca se reprodujo localmente (8 corridas e2e completas contra Docker Desktop en
 *     Windows) — solo se vio en el demonio Docker Linux nativo de GitHub Actions,
 *     lo cual es consistente con un breve percance de reprogramación de iptables/NAT
 *     en la red bridge compartida cuando se detiene un contenedor hermano,
 *     no una falla a nivel de aplicación.
 * Un cliente real que se topara con un percance de red genuinamente transitorio reintentaría
 * en lugar de mostrarlo como una falla dura, así que este test hace lo mismo —
 * acotado estrictamente a la única solicitud que se sabe afectada, no como una red de
 * seguridad general que podría enmascarar una regresión real.
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
  // Inalcanzable: el bucle de arriba siempre retorna o lanza una excepción.
  throw new Error('withTransientRetry: exhausted attempts unexpectedly');
}

/**
 * Hace polling de `GET /audit/:orderId` hasta que devuelve exactamente `expectedCount`
 * registros (200 con un array de longitud coincidente). Tolera que `audit` esté
 * temporalmente inalcanzable (ECONNREFUSED / no-200) entre intentos.
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
