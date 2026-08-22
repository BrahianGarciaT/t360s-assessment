import 'reflect-metadata';
import {
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '../enums/order-status.enum';

export class OrderStatusChangedEvent {
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @IsUUID()
  orderId!: string;

  @IsOptional()
  @IsEnum(OrderStatus)
  fromStatus!: OrderStatus | null;

  @IsEnum(OrderStatus)
  toStatus!: OrderStatus;

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
