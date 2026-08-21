import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderItemDto {
  @ApiProperty({
    description: 'Identificador del producto',
    example: 'prod-123',
  })
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @ApiProperty({
    description: 'Nombre del producto',
    example: 'Teclado mecánico',
  })
  @IsString()
  @IsNotEmpty()
  productName!: string;

  @ApiProperty({ description: 'Cantidad de unidades', example: 2, minimum: 1 })
  @IsNumber()
  @Min(1)
  quantity!: number;

  @ApiProperty({ description: 'Precio unitario', example: 49.99, minimum: 0 })
  @IsNumber()
  @Min(0)
  price!: number;
}

export class CreateOrderDto {
  @ApiProperty({
    description: 'Identificador del usuario que crea la orden',
    example: 'user-456',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description: 'Items incluidos en la orden',
    type: [OrderItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ApiPropertyOptional({
    description: 'Notas adicionales sobre la orden',
    example: 'Entregar en horario de oficina',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
