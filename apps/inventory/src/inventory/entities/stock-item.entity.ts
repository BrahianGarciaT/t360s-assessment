import {
  Check,
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `quantity` es el stock total disponible en existencia; `reserved` es el stock retenido por
 * reservas `held`. El stock disponible siempre se deriva (`quantity - reserved`),
 * nunca se almacena, por lo que nunca puede desincronizarse.
 */
@Entity('stock_items')
@Check(
  'CHK_STOCK_RESERVED_BOUNDS',
  '"reserved" >= 0 AND "reserved" <= "quantity"',
)
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
