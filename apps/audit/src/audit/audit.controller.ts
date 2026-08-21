import { Controller, Get, Param } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ORDER_EVENTS, OrderStatusChangedEvent } from '@app/shared';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @MessagePattern(ORDER_EVENTS.STATUS_CHANGED)
  async handleOrderStatusChanged(
    @Payload() event: OrderStatusChangedEvent,
  ): Promise<void> {
    await this.auditService.createLog({
      orderId: event.orderId,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      timestamp: new Date(event.timestamp),
      metadata: event.metadata,
    });
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Obtiene el historial de auditoría de una orden' })
  @ApiParam({ name: 'orderId', description: 'UUID de la orden' })
  findByOrderId(@Param('orderId') orderId: string) {
    return this.auditService.findByOrderId(orderId);
  }
}
