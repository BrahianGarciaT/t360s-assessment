import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * `quantity` is total on-hand stock; `reserved` is stock held by `held`
 * reservations. Available stock is always derived (`quantity - reserved`),
 * never stored, so it can never drift out of sync.
 */
@Entity('stock_items')
@Check('CHK_STOCK_RESERVED_BOUNDS', '"reserved" >= 0 AND "reserved" <= "quantity"')
export class StockItem {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'int', default: 0 })
  reserved!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
