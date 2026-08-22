import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema()
export class AuditLog {
  @Prop({ required: true, unique: true })
  eventId!: string;

  @Prop({ required: true, index: true })
  orderId!: string;

  /** Discriminador del tipo de evento — `order.status_changed`, `inventory.reserved`, etc. */
  @Prop({ required: true, index: true })
  eventType!: string;

  @Prop({ type: String, default: null })
  fromStatus!: string | null;

  @Prop({ type: String, default: null })
  toStatus!: string | null;

  @Prop({ required: true })
  timestamp!: Date;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, any>;

  /** Payload específico de eventos de inventory (items reservados, releasedReason, etc.) — null para eventos de orden. */
  @Prop({ type: Object, default: null })
  details!: Record<string, any> | null;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
