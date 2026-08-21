import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '@app/shared';

export class UpdateStatusDto {
  @ApiProperty({ description: 'Nuevo estado de la orden', enum: OrderStatus })
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}
