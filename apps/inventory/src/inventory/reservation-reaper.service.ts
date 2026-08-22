import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InventoryRepository } from './inventory.repository';
import { getInventoryConfig, InventoryConfig } from './inventory.constants';

/**
 * Red de seguridad de compensación para la ventana reserve→commit/cancel: libera
 * reservas `held` que nunca alcanzaron un estado terminal antes de su
 * TTL, devolviendo la cantidad reservada al stock disponible. Sigue el mismo
 * patrón de `OutboxPurgeService` (copia de config + `@Cron`).
 */
@Injectable()
export class ReservationReaperService {
  private readonly config: InventoryConfig;

  constructor(
    private readonly inventoryRepository: InventoryRepository,
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
      // El reaper es un disparador interno de @Cron, no un evento reentregado
      // del outbox, así que no hay un `eventId` real que reenviar. Se sintetiza uno para
      // que esta llamada cumpla el contrato de deduplicación por eventId de finalize(),
      // tal como lo haría un evento real — determinista y único por
      // reserva, ya que claimExpired solo devuelve una reserva HELD
      // una vez (deja de coincidir con el filtro HELD en cuanto se libera).
      try {
        await this.inventoryRepository.finalize(
          reservation.orderId,
          'release',
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
