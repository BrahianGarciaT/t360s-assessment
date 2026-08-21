import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';

// MongoDB duplicate-key error code (unique index violation).
const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  /**
   * At-least-once delivery from the outbox poller means the same eventId can
   * arrive more than once. A duplicate is a successful no-op, not an error —
   * throwing here would propagate through `send()` and the poller would
   * retry an event that was already recorded.
   */
  async createLog(dto: CreateAuditLogDto): Promise<AuditLog> {
    try {
      const log = new this.auditLogModel(dto);
      return await log.save();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        this.logger.warn(
          `Duplicate eventId ${dto.eventId} received — treating as a no-op`,
        );
        const existing = await this.auditLogModel.findOne({
          eventId: dto.eventId,
        });
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: number }).code === MONGO_DUPLICATE_KEY_ERROR_CODE
    );
  }

  async findByOrderId(orderId: string): Promise<AuditLog[]> {
    return this.auditLogModel.find({ orderId }).sort({ timestamp: 1 }).exec();
  }
}
