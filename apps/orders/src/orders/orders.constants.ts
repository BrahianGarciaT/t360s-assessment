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
  };
}
