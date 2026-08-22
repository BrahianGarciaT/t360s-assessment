import { Type } from 'class-transformer';
import { IsDate, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateAuditLogDto {
  @IsString()
  eventId!: string;

  @IsString()
  orderId!: string;

  @IsString()
  eventType!: string;

  @IsOptional()
  @IsString()
  fromStatus!: string | null;

  @IsOptional()
  @IsString()
  toStatus!: string | null;

  @IsDate()
  @Type(() => Date)
  timestamp!: Date;

  @IsOptional()
  metadata?: Record<string, any>;

  @IsOptional()
  @IsObject()
  details?: Record<string, any> | null;
}
