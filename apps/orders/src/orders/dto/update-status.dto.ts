import { IsEnum } from 'class-validator';
import { OrderStatus } from '@app/shared';

export class UpdateStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;
}
