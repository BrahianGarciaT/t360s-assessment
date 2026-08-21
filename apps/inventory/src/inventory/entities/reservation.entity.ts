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
 * `orderId` is the PK: it doubles as the idempotency key so reserve → commit
 * → release always resolve to one identity, and a duplicate reserve request
 * (23505 unique violation) is a safe no-op instead of a second reservation.
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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
