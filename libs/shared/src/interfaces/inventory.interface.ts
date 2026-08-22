import 'reflect-metadata';
import {
  IsArray,
  IsDate,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReserveStockItem {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;
}

/** Clave de idempotencia — refleja la PK de `reservations.orderId`. */
export class ReserveStockRequest {
  @IsUUID()
  orderId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReserveStockItem)
  items!: ReserveStockItem[];

  @IsOptional()
  @IsString()
  correlationId?: string;

  @IsString()
  @IsNotEmpty()
  apiKey!: string;
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
export class InventoryFinalizeEvent {
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @IsUUID()
  orderId!: string;

  @Type(() => Date)
  @IsDate()
  timestamp!: Date;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}
