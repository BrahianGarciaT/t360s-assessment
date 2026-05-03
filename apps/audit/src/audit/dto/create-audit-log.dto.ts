import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString } from 'class-validator';

export class CreateAuditLogDto {
  @IsString()
  orderId!: string;

  @IsOptional()
  @IsString()
  fromStatus!: string | null;

  @IsString()
  toStatus!: string;

  @IsDate()
  @Type(() => Date)
  timestamp!: Date;

  @IsOptional()
  metadata?: Record<string, any>;
}
