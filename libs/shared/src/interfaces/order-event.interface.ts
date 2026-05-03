import { OrderStatus } from '../enums/order-status.enum';

export interface OrderStatusChangedEvent {
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  timestamp: Date;
  metadata?: Record<string, any>;
}
