import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  async createLog(dto: CreateAuditLogDto): Promise<AuditLog> {
    const log = new this.auditLogModel(dto);
    return log.save();
  }

  async findByOrderId(orderId: string): Promise<AuditLog[]> {
    const logs = await this.auditLogModel
      .find({ orderId })
      .sort({ timestamp: 1 })
      .exec();

    if (!logs.length) {
      throw new NotFoundException(`No audit logs found for order ${orderId}`);
    }

    return logs;
  }
}
