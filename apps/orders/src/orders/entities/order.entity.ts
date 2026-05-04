import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderStatus } from '@app/shared';

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column({ type: 'jsonb' })
  items!: OrderItem[];

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status!: OrderStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Index('IDX_ORDERS_SEARCH_VECTOR', { synchronize: false })
  @Column({
    type: 'tsvector',
    nullable: true,
    select: false,
  })
  searchVector!: unknown;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
