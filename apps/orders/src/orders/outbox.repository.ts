import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
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

  /** Inserted within the caller's transaction manager — never through `this.repository`. */
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

  /** Must run BEFORE the delivery attempt: a crash mid-send reschedules instead of hot-looping. */
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

  /** `attempts` already reflects the bump from `markAttempt` — decides pending (retryable) vs failed. */
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
}
