import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OutboxEventStatus } from '../outbox.constants';

@Entity('outbox_events')
@Index('IDX_OUTBOX_DISPATCH', ['status', 'nextAttemptAt'])
export class OutboxEvent {
  /** También viaja por el wire como `eventId` — una sola identidad, sin divergencia entre reintentos. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({
    type: 'varchar',
    length: 16,
    default: OutboxEventStatus.PENDING,
  })
  status!: OutboxEventStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
