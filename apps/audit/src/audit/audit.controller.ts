import { Controller, Get, Param } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ORDER_EVENTS, OrderStatusChangedEvent } from '@app/shared';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    @InjectPinoLogger(AuditController.name)
    private readonly logger: PinoLogger,
  ) {}

  @MessagePattern(ORDER_EVENTS.STATUS_CHANGED)
  async handleOrderStatusChanged(
    @Payload() event: OrderStatusChangedEvent,
  ): Promise<{ ok: true; eventId: string }> {
    this.logger.info(
      {
        correlationId: event.metadata?.correlationId,
        eventId: event.eventId,
        orderId: event.orderId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
      },
      'Received order.status_changed event',
    );

    await this.auditService.createLog({
      eventId: event.eventId,
      orderId: event.orderId,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      timestamp: new Date(event.timestamp),
      metadata: event.metadata,
    });

    // `send()` del lado de orders necesita un ack real a nivel de aplicación — un
    // objeto plano determinista evita serializar un documento de Mongoose
    // por TCP (referencias circulares, internals del driver) sin ningún beneficio.
    return { ok: true, eventId: event.eventId };
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Obtiene el historial de auditoría de una orden' })
  @ApiParam({ name: 'orderId', description: 'UUID de la orden' })
  findByOrderId(@Param('orderId') orderId: string) {
    return this.auditService.findByOrderId(orderId);
  }
}
