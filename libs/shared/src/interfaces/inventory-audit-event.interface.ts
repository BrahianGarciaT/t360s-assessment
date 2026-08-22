import 'reflect-metadata';
import {
  IsDate,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Payload que inventory emite hacia audit para cada cambio real de estado de una reserva. */
export class InventoryAuditEvent {
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
  details?: Record<string, any>;

  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}
