import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { getInventoryConfig, InventoryConfig } from './inventory.constants';

/**
 * Red de seguridad compensatoria para la ventana reserve→commit/cancel:
 * libera las reservas `held` que nunca llegaron a un estado terminal antes
 * de su TTL, devolviendo la cantidad reservada al stock disponible. Sigue
 * el mismo idioma que `OutboxPurgeService` (clon de config + `@Cron`).
 *
 * Libera a través de `InventoryService.release()` (no llamando directo a
 * `InventoryRepository.finalize()`) para que el release por TTL quede
 * auditado hacia `audit` igual que cualquier otro release — antes este
 * camino se saltaba la capa de servicio y ese release nunca dejaba rastro.
 */
@Injectable()
export class ReservationReaperService {
  private readonly config: InventoryConfig;

  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly inventoryService: InventoryService,
    @InjectPinoLogger(ReservationReaperService.name)
    private readonly logger: PinoLogger,
  ) {
    this.config = getInventoryConfig();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reap(): Promise<void> {
    const expired = await this.inventoryRepository.claimExpired(
      this.config.reapBatchSize,
    );

    for (const reservation of expired) {
      // El reaper es un trigger interno de @Cron, no un evento reentregado
      // desde el outbox, así que no hay un `eventId` real que reenviar. Se
      // sintetiza uno para satisfacer el contrato de deduplicación por
      // eventId de finalize() — determinista y único por reserva, ya que
      // claimExpired solo devuelve una reserva HELD una única vez (deja de
      // matchear el filtro HELD apenas se libera).
      try {
        await this.inventoryService.release(
          reservation.orderId,
          `internal:reaper:${reservation.orderId}`,
          'expired',
        );
      } catch (error) {
        this.logger.error(
          { orderId: reservation.orderId, err: error },
          'Failed to release expired reservation — will retry next tick',
        );
      }
    }

    if (expired.length > 0) {
      this.logger.info(
        { count: expired.length },
        'Released expired reservations past their TTL',
      );
    }
  }
}
