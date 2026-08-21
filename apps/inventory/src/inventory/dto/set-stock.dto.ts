import { IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetStockDto {
  @ApiProperty({
    description: 'Cantidad total en stock',
    example: 100,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  quantity!: number;
}
