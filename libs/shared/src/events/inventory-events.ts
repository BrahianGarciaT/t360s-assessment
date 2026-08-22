export const INVENTORY_PATTERNS = {
  RESERVE: 'inventory.reserve',
  COMMIT: 'inventory.commit',
  RELEASE: 'inventory.release',
} as const;

export const INVENTORY_EVENTS = {
  COMMIT_REQUESTED: 'inventory.commit_requested',
  RELEASE_REQUESTED: 'inventory.release_requested',
} as const;

/**
 * Emitidos por inventory hacia audit (fire-and-forget, best-effort) para
 * dejar rastro de cada cambio real de estado de una reserva — a diferencia
 * de INVENTORY_EVENTS de arriba, que es lo que orders *solicita*, estos son
 * lo que inventory efectivamente *hizo*.
 */
export const INVENTORY_AUDIT_EVENTS = {
  RESERVED: 'inventory.reserved',
  COMMITTED: 'inventory.committed',
  RELEASED: 'inventory.released',
} as const;
