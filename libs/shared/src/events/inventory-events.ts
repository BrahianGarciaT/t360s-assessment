export const INVENTORY_PATTERNS = {
  RESERVE: 'inventory.reserve',
  COMMIT: 'inventory.commit',
  RELEASE: 'inventory.release',
} as const;

export const INVENTORY_EVENTS = {
  COMMIT_REQUESTED: 'inventory.commit_requested',
  RELEASE_REQUESTED: 'inventory.release_requested',
} as const;
