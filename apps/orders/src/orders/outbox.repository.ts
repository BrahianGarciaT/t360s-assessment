import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { calculateBackoffMs, OutboxEventStatus } from './outbox.constants';

export interface OutboxEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

const LAST_ERROR_MAX_LENGTH = 1000;

@Injectable()
export class OutboxRepository {
  constructor(
    @InjectRepository(OutboxEvent)
    private readonly repository: Repository<OutboxEvent>,
  ) {}

  /** Se inserta dentro del transaction manager del caller — nunca a través de `this.repository`. */
  async insertWithin(
    manager: EntityManager,
    event: OutboxEventInput,
  ): Promise<OutboxEvent> {
    const repo = manager.getRepository(OutboxEvent);
    const entity = repo.create({
      eventType: event.eventType,
      payload: event.payload,
    });
    return repo.save(entity);
  }

  async claimDue(batchSize: number): Promise<OutboxEvent[]> {
    return this.repository.find({
      where: {
        status: OutboxEventStatus.PENDING,
        nextAttemptAt: LessThanOrEqual(new Date()),
      },
      order: { createdAt: 'ASC' },
      take: batchSize,
    });
  }

  /** Debe ejecutarse ANTES del intento de entrega: un crash a mitad del envío reprograma en vez de hacer hot-looping. */
  async markAttempt(
    row: OutboxEvent,
    backoffBaseMs: number,
    backoffMaxMs: number,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const lastAttemptAt = new Date();
    const nextAttemptAt = new Date(
      lastAttemptAt.getTime() +
        calculateBackoffMs(attempts, backoffBaseMs, backoffMaxMs),
    );

    await this.repository.update(row.id, {
      attempts,
      lastAttemptAt,
      nextAttemptAt,
    });

    row.attempts = attempts;
    row.lastAttemptAt = lastAttemptAt;
    row.nextAttemptAt = nextAttemptAt;
  }

  async markSent(id: string): Promise<void> {
    await this.repository.update(id, {
      status: OutboxEventStatus.SENT,
      sentAt: new Date(),
    });
  }

  /** `attempts` ya refleja el incremento de `markAttempt` — decide entre pending (reintentable) vs failed. */
  async markError(
    id: string,
    attempts: number,
    maxAttempts: number,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.repository.update(id, {
      status:
        attempts >= maxAttempts
          ? OutboxEventStatus.FAILED
          : OutboxEventStatus.PENDING,
      lastError: message.slice(0, LAST_ERROR_MAX_LENGTH),
    });
  }

  /** Purga las filas entregadas que superan su ventana de retención. Devuelve la cantidad de filas eliminadas. */
  async deleteSentOlderThan(cutoff: Date): Promise<number> {
    const result = await this.repository.delete({
      status: OutboxEventStatus.SENT,
      sentAt: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }
}
