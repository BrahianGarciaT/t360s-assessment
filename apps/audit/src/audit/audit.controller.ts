import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ApiKeyGuard,
  INVENTORY_AUDIT_EVENTS,
  InventoryAuditEvent,
  ORDER_EVENTS,
  OrderStatusChangedEvent,
  RpcApiKeyGuard,
} from '@app/shared';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    @InjectPinoLogger(AuditController.name)
    private readonly logger: PinoLogger,
  ) {}

  @UseGuards(RpcApiKeyGuard)
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
      eventType: ORDER_EVENTS.STATUS_CHANGED,
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

  @EventPattern(INVENTORY_AUDIT_EVENTS.RESERVED)
  @UseGuards(RpcApiKeyGuard)
  async handleInventoryReserved(
    @Payload() event: InventoryAuditEvent,
  ): Promise<void> {
    this.logger.info(
      { eventId: event.eventId, orderId: event.orderId },
      'Received inventory.reserved event',
    );
    await this.auditService.createInventoryLog(
      INVENTORY_AUDIT_EVENTS.RESERVED,
      event,
    );
  }

  @EventPattern(INVENTORY_AUDIT_EVENTS.COMMITTED)
  @UseGuards(RpcApiKeyGuard)
  async handleInventoryCommitted(
    @Payload() event: InventoryAuditEvent,
  ): Promise<void> {
    this.logger.info(
      { eventId: event.eventId, orderId: event.orderId },
      'Received inventory.committed event',
    );
    await this.auditService.createInventoryLog(
      INVENTORY_AUDIT_EVENTS.COMMITTED,
      event,
    );
  }

  @EventPattern(INVENTORY_AUDIT_EVENTS.RELEASED)
  @UseGuards(RpcApiKeyGuard)
  async handleInventoryReleased(
    @Payload() event: InventoryAuditEvent,
  ): Promise<void> {
    this.logger.info(
      { eventId: event.eventId, orderId: event.orderId },
      'Received inventory.released event',
    );
    await this.auditService.createInventoryLog(
      INVENTORY_AUDIT_EVENTS.RELEASED,
      event,
    );
  }

  @Get(':orderId')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('x-api-key')
  @ApiOperation({ summary: 'Obtiene el historial de auditoría de una orden' })
  @ApiParam({ name: 'orderId', description: 'UUID de la orden' })
  findByOrderId(@Param('orderId') orderId: string) {
    return this.auditService.findByOrderId(orderId);
  }
}
