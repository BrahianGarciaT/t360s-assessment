export interface ReserveStockItem {
  productId: string;
  quantity: number;
}

export interface ReserveStockRequest {
  /** Clave de idempotencia — refleja la PK de `reservations.orderId`. */
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

/** Transportado por el outbox, por lo que `eventId` está presente igual que en `OrderStatusChangedEvent`. */
export interface InventoryFinalizeEvent {
  eventId: string;
  orderId: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}
