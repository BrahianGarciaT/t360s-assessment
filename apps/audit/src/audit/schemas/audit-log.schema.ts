import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema()
export class AuditLog {
  @Prop({ required: true, index: true })
  orderId!: string;

  @Prop({ type: String, default: null })
  fromStatus!: string | null;

  @Prop({ required: true })
  toStatus!: string;

  @Prop({ required: true })
  timestamp!: Date;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, any>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
