export interface InventoryConfig {
  reservationTtlMinutes: number;
  reapBatchSize: number;
}

const DEFAULT_INVENTORY_CONFIG: InventoryConfig = {
  reservationTtlMinutes: 15,
  reapBatchSize: 100,
};

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Construye la configuración de reservas de inventario a partir de variables
 * de entorno, usando como respaldo los valores por defecto documentados cuando
 * faltan o son inválidos. Es una copia de `getOutboxConfig()` (`outbox.constants.ts`).
 */
export function getInventoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): InventoryConfig {
  return {
    reservationTtlMinutes: parseIntEnv(
      env.INVENTORY_RESERVATION_TTL_MINUTES,
      DEFAULT_INVENTORY_CONFIG.reservationTtlMinutes,
    ),
    reapBatchSize: parseIntEnv(
      env.INVENTORY_REAP_BATCH_SIZE,
      DEFAULT_INVENTORY_CONFIG.reapBatchSize,
    ),
  };
}
