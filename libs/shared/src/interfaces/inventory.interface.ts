export interface ReserveStockItem {
  productId: string;
  quantity: number;
}

export interface ReserveStockRequest {
  /** Idempotency key — mirrors `reservations.orderId` PK. */
  orderId: string;
  items: ReserveStockItem[];
  correlationId?: string;
}

export interface StockShortfall {
  productId: string;
  requested: number;
  available: number;
}

export type ReserveStockResponse =
  | { ok: true; orderId: string; expiresAt: string }
  | {
      ok: false;
      reason: 'INSUFFICIENT_STOCK' | 'UNKNOWN_PRODUCT';
      shortfalls: StockShortfall[];
    };

/** Carried by the outbox, so `eventId` is present exactly like `OrderStatusChangedEvent`. */
export interface InventoryFinalizeEvent {
  eventId: string;
  orderId: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}
