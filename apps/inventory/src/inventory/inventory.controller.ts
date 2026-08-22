import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ApiKeyGuard,
  INVENTORY_PATTERNS,
  InventoryFinalizeEvent,
  ReserveStockRequest,
  ReserveStockResponse,
} from '@app/shared';
import { InventoryService } from './inventory.service';
import { SetStockDto } from './dto/set-stock.dto';

@ApiTags('inventory')
@Controller('stock')
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    @InjectPinoLogger(InventoryController.name)
    private readonly logger: PinoLogger,
  ) {}

  @MessagePattern(INVENTORY_PATTERNS.RESERVE)
  async handleReserve(
    @Payload() request: ReserveStockRequest,
  ): Promise<ReserveStockResponse> {
    this.logger.info(
      {
        correlationId: request.correlationId,
        orderId: request.orderId,
        itemCount: request.items.length,
      },
      'Received inventory.reserve request',
    );

    return this.inventoryService.reserve(request);
  }

  @MessagePattern(INVENTORY_PATTERNS.COMMIT)
  async handleCommit(
    @Payload() event: InventoryFinalizeEvent,
  ): Promise<{ ok: true; orderId: string }> {
    this.logger.info(
      {
        correlationId: event.metadata?.correlationId,
        eventId: event.eventId,
        orderId: event.orderId,
      },
      'Received inventory.commit_requested event',
    );

    return this.inventoryService.commit(event.orderId, event.eventId);
  }

  @MessagePattern(INVENTORY_PATTERNS.RELEASE)
  async handleRelease(
    @Payload() event: InventoryFinalizeEvent,
  ): Promise<{ ok: true; orderId: string }> {
    this.logger.info(
      {
        correlationId: event.metadata?.correlationId,
        eventId: event.eventId,
        orderId: event.orderId,
      },
      'Received inventory.release_requested event',
    );

    // Solo la cancelación de una orden dispara este patrón desde orders; la expiración por TTL
    // se libera internamente mediante el reaper, nunca a través de este patrón TCP.
    return this.inventoryService.release(
      event.orderId,
      event.eventId,
      'cancelled',
    );
  }

  @Put(':productId')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('x-api-key')
  @ApiOperation({
    summary:
      'Fija (upsert idempotente) la cantidad total en stock de un producto — fixture de pruebas, no es una API de reabastecimiento',
  })
  @ApiParam({ name: 'productId' })
  setStock(@Param('productId') productId: string, @Body() dto: SetStockDto) {
    return this.inventoryService.setStock(productId, dto.quantity);
  }

  @Get(':productId')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('x-api-key')
  @ApiOperation({ summary: 'Obtiene el nivel de stock actual de un producto' })
  @ApiParam({ name: 'productId' })
  getStock(@Param('productId') productId: string) {
    return this.inventoryService.getStockLevel(productId);
  }
}
