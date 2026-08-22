import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface ReservationItem {
  productId: string;
  quantity: number;
}

export enum ReservationStatus {
  HELD = 'held',
  COMMITTED = 'committed',
  RELEASED = 'released',
}

export type ReleasedReason = 'cancelled' | 'expired';

/**
 * `orderId` es la PK: también funciona como clave de idempotencia, de modo que reserve → commit
 * → release siempre resuelven a una misma identidad, y una solicitud de reserve duplicada
 * (violación de unicidad 23505) es un no-op seguro en lugar de una segunda reserva.
 */
@Entity('reservations')
@Index('IDX_RESERVATION_REAP', ['status', 'expiresAt'])
export class Reservation {
  @PrimaryColumn({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'jsonb' })
  items!: ReservationItem[];

  @Column({
    type: 'varchar',
    length: 16,
    default: ReservationStatus.HELD,
  })
  status!: ReservationStatus;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'varchar', length: 16, nullable: true })
  releasedReason!: ReleasedReason | null;

  /**
   * El `eventId` del evento finalize/release que hizo transicionar por última vez esta
   * reserva fuera de `held` — sigue el mismo patrón de deduplicación por clave única
   * de `AuditLog.eventId` (el catch de Mongo 11000 en `audit.service.ts`), adaptado a Postgres
   * mediante un índice único. El ciclo de vida de una reserva es lineal (reserve → exactamente
   * un evento commit-or-release), así que una sola columna basta para indexar la deduplicación
   * según el `eventId` real, no solo el `status`. Es nullable porque una reserva
   * `held` todavía no fue finalizada.
   */
  @Index('IDX_RESERVATION_PROCESSED_EVENT_ID', { unique: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  processedEventId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
