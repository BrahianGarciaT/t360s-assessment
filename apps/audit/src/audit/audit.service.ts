import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';

// Código de error de clave duplicada de MongoDB (violación de índice único).
const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  /**
   * La entrega at-least-once del poller del outbox implica que el mismo eventId
   * puede llegar más de una vez. Un duplicado es un no-op exitoso, no un error —
   * lanzar una excepción aquí se propagaría a través de `send()` y el poller
   * reintentaría un evento que ya fue registrado.
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
