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

  /**
   * The `eventId` of the finalize/release event that last transitioned this
   * reservation out of `held` — mirrors `AuditLog.eventId`'s unique-key dedup
   * pattern (`audit.service.ts`'s Mongo 11000 catch), scoped to Postgres via
   * a unique index. A reservation's lifecycle is linear (reserve → exactly
   * one commit-or-release event), so one column is enough to key dedup off
   * the real `eventId`, not just `status`. Nullable because a `held`
   * reservation has not been finalized yet.
   */
  @Index('IDX_RESERVATION_PROCESSED_EVENT_ID', { unique: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  processedEventId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
