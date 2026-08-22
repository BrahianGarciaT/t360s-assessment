export const AUDIT_TCP_CLIENT = 'AUDIT_TCP_CLIENT';
export const INVENTORY_TCP_CLIENT = 'INVENTORY_TCP_CLIENT';

export interface InventoryClientConfig {
  sendTimeoutMs: number;
  breakerFailureThreshold: number;
  breakerResetTimeoutMs: number;
}

const DEFAULT_INVENTORY_CLIENT_CONFIG: InventoryClientConfig = {
  sendTimeoutMs: 3000,
  breakerFailureThreshold: 5,
  breakerResetTimeoutMs: 15000,
};

/**
 * Solo acepta enteros `> 0` — un valor `0`, negativo, o no numérico cae en
 * `fallback`. Gotcha conocido para el rollback del circuit breaker: poner
 * `INVENTORY_BREAKER_FAILURE_THRESHOLD=0` NO lo desactiva, vuelve al default
 * (`5`). Para desactivarlo efectivamente hay que usar un valor muy alto
 * (p. ej. `1000000`) o revertir el cambio — ver README, sección "Circuit
 * breaker en la llamada síncrona a inventory".
 */
function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Construye la configuración de send-timeout de `INVENTORY_TCP_CLIENT` a
 * partir de variables de entorno, recurriendo al valor por defecto
 * documentado cuando falta o es inválido. Es un clon del idioma
 * `parseIntEnv` de `getOutboxConfig()` (`outbox.constants.ts`), más ajustado
 * que `OUTBOX_SEND_TIMEOUT_MS` porque esta llamada está en el path de
 * request de cara al usuario `POST /orders`.
 */
export function getInventoryClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): InventoryClientConfig {
  return {
    sendTimeoutMs: parseIntEnv(
      env.INVENTORY_SEND_TIMEOUT_MS,
      DEFAULT_INVENTORY_CLIENT_CONFIG.sendTimeoutMs,
    ),
    breakerFailureThreshold: parseIntEnv(
      env.INVENTORY_BREAKER_FAILURE_THRESHOLD,
      DEFAULT_INVENTORY_CLIENT_CONFIG.breakerFailureThreshold,
    ),
    breakerResetTimeoutMs: parseIntEnv(
      env.INVENTORY_BREAKER_RESET_TIMEOUT_MS,
      DEFAULT_INVENTORY_CLIENT_CONFIG.breakerResetTimeoutMs,
    ),
  };
}
