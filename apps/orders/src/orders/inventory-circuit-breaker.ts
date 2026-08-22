import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { getInventoryClientConfig } from './orders.constants';

export class CircuitOpenError extends Error {
  constructor(
    message = 'Circuit breaker is open — inventory call short-circuited',
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

const BREAKER_STATE = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
} as const;

type BreakerState = (typeof BREAKER_STATE)[keyof typeof BREAKER_STATE];

@Injectable()
export class InventoryCircuitBreaker {
  private readonly config = getInventoryClientConfig();
  private state: BreakerState = BREAKER_STATE.CLOSED;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(
    @InjectPinoLogger(InventoryCircuitBreaker.name)
    private readonly logger: PinoLogger,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const isTrial = this.admit();

    try {
      const result = await operation();
      this.onSuccess(isTrial);
      return result;
    } catch (error) {
      this.onFailure(isTrial);
      throw error;
    }
  }

  /**
   * Synchronous check-and-set, run to completion before the first `await`
   * inside `execute()`. Node is single-threaded, so this decision cannot be
   * interleaved with a concurrent call — the single-flight guarantee for the
   * half-open trial comes from this atomicity, not from a lock primitive.
   */
  private admit(): boolean {
    if (this.state === BREAKER_STATE.CLOSED) {
      return false;
    }

    if (this.state === BREAKER_STATE.OPEN) {
      if (this.resetTimeoutElapsed()) {
        this.transitionToHalfOpen();
        return true;
      }

      throw new CircuitOpenError();
    }

    // half-open: single-flight — only one trial admitted at a time.
    if (this.trialInFlight) {
      throw new CircuitOpenError();
    }

    this.trialInFlight = true;
    return true;
  }

  private resetTimeoutElapsed(): boolean {
    const openedAt = this.openedAt ?? 0;
    return Date.now() - openedAt >= this.config.breakerResetTimeoutMs;
  }

  private transitionToHalfOpen(): void {
    this.state = BREAKER_STATE.HALF_OPEN;
    this.trialInFlight = true;
    this.logger.info(
      { state: this.state },
      'Circuit breaker reset timeout elapsed — transitioning to half-open for a single trial request',
    );
  }

  private onSuccess(isTrial: boolean): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
    this.state = BREAKER_STATE.CLOSED;

    if (isTrial) {
      this.logger.info(
        { state: this.state },
        'Circuit breaker trial succeeded — circuit is now closed',
      );
    }
  }

  private onFailure(isTrial: boolean): void {
    this.trialInFlight = false;

    if (isTrial) {
      // A single failed probe re-opens the circuit immediately — no second
      // threshold count. The reset timeout restarts from this point.
      this.tripOpen('Circuit breaker trial failed — reopening the circuit');
      return;
    }

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.config.breakerFailureThreshold) {
      this.tripOpen(
        'Circuit breaker tripped open after consecutive transport failures',
      );
    }
  }

  private tripOpen(logMessage: string): void {
    this.state = BREAKER_STATE.OPEN;
    this.openedAt = Date.now();
    this.logger.warn(
      { state: this.state, consecutiveFailures: this.consecutiveFailures },
      logMessage,
    );
  }
}
