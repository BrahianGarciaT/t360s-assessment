import { PinoLogger } from 'nestjs-pino';
import {
  CircuitOpenError,
  InventoryCircuitBreaker,
} from './inventory-circuit-breaker';

describe('InventoryCircuitBreaker', () => {
  let logger: { warn: jest.Mock; info: jest.Mock; error: jest.Mock };
  let breaker: InventoryCircuitBreaker;

  beforeEach(() => {
    logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    breaker = new InventoryCircuitBreaker(logger as unknown as PinoLogger);
  });

  describe('closed state', () => {
    it('invokes the operation and returns its resolved value', async () => {
      const operation = jest.fn().mockResolvedValue('reserved');

      const result = await breaker.execute(operation);

      expect(result).toBe('reserved');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('trips to open after the 5th consecutive transport failure and logs the transition', async () => {
      const operation = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));

      for (let i = 0; i < 5; i += 1) {
        await expect(breaker.execute(operation)).rejects.toThrow(
          'ECONNREFUSED',
        );
      }

      expect(operation).toHaveBeenCalledTimes(5);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'open' }),
        expect.stringContaining('open'),
      );
    });
  });

  describe('open state', () => {
    it('rejects the 6th call with CircuitOpenError without invoking the operation', async () => {
      const operation = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));

      for (let i = 0; i < 5; i += 1) {
        await expect(breaker.execute(operation)).rejects.toThrow(
          'ECONNREFUSED',
        );
      }
      operation.mockClear();

      await expect(breaker.execute(operation)).rejects.toThrow(
        CircuitOpenError,
      );
      expect(operation).not.toHaveBeenCalled();
    });
  });

  describe('half-open state', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const tripOpen = async (operation: jest.Mock) => {
      jest.setSystemTime(0);
      for (let i = 0; i < 5; i += 1) {
        await expect(breaker.execute(operation)).rejects.toThrow(
          'ECONNREFUSED',
        );
      }
      operation.mockClear();
    };

    it('transitions to half-open once the reset timeout elapses and admits exactly one trial', async () => {
      const operation = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));
      await tripOpen(operation);

      jest.setSystemTime(15_000);
      operation.mockResolvedValueOnce('reserved');

      const result = await breaker.execute(operation);

      expect(result).toBe('reserved');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'half-open' }),
        expect.stringContaining('half-open'),
      );
    });

    it('rejects a concurrent request while a trial is in flight without invoking the operation', async () => {
      const failing = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await tripOpen(failing);

      jest.setSystemTime(15_000);

      let resolveTrial!: (value: string) => void;
      const trialOperation = jest.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveTrial = resolve;
          }),
      );

      const trialPromise = breaker.execute(trialOperation);
      // Prevents Node's unhandled-rejection detector from tearing down the
      // process while this promise sits unresolved during the assertions
      // below; the real outcome is still asserted via the final `await`.
      trialPromise.catch(() => undefined);
      const concurrentOperation = jest.fn().mockResolvedValue('should-not-run');

      await expect(breaker.execute(concurrentOperation)).rejects.toThrow(
        CircuitOpenError,
      );
      expect(concurrentOperation).not.toHaveBeenCalled();

      resolveTrial('reserved');
      await expect(trialPromise).resolves.toBe('reserved');
    });

    it('closes the circuit and resets the failure count when the trial succeeds', async () => {
      const failing = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await tripOpen(failing);

      jest.setSystemTime(15_000);
      const trialOperation = jest.fn().mockResolvedValue('reserved');
      await breaker.execute(trialOperation);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'closed' }),
        expect.stringContaining('closed'),
      );

      // The circuit is closed again, so a normal call must go through
      // without being short-circuited.
      const nextOperation = jest.fn().mockResolvedValue('next');
      await expect(breaker.execute(nextOperation)).resolves.toBe('next');
      expect(nextOperation).toHaveBeenCalledTimes(1);
    });

    it('reopens the circuit immediately when the trial fails, restarting the reset timeout', async () => {
      const failing = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await tripOpen(failing);

      jest.setSystemTime(15_000);
      const trialOperation = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(breaker.execute(trialOperation)).rejects.toThrow(
        'ECONNREFUSED',
      );

      // Still within the (restarted) reset window relative to the trial
      // failure — must short-circuit without invoking the operation.
      jest.setSystemTime(15_000 + 14_999);
      const tooSoonOperation = jest.fn().mockResolvedValue('too-soon');
      await expect(breaker.execute(tooSoonOperation)).rejects.toThrow(
        CircuitOpenError,
      );
      expect(tooSoonOperation).not.toHaveBeenCalled();

      // Past the restarted reset window — admits a new trial.
      jest.setSystemTime(15_000 + 15_000);
      const recoveredOperation = jest.fn().mockResolvedValue('recovered');
      await expect(breaker.execute(recoveredOperation)).resolves.toBe(
        'recovered',
      );
    });
  });

  describe('multi-instance isolation (per-replica state, no shared store)', () => {
    it('does not share state between two independent instances', async () => {
      const loggerA = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
      const loggerB = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
      const breakerA = new InventoryCircuitBreaker(
        loggerA as unknown as PinoLogger,
      );
      const breakerB = new InventoryCircuitBreaker(
        loggerB as unknown as PinoLogger,
      );

      const failingOperation = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 5; i += 1) {
        await expect(breakerA.execute(failingOperation)).rejects.toThrow(
          'ECONNREFUSED',
        );
      }

      // breakerA is now open — the 6th call must short-circuit without
      // invoking the operation.
      failingOperation.mockClear();
      await expect(breakerA.execute(failingOperation)).rejects.toThrow(
        CircuitOpenError,
      );
      expect(failingOperation).not.toHaveBeenCalled();

      // breakerB is a fully independent instance that never saw a failure.
      // If any state (module-level, static, or otherwise shared) leaked
      // from breakerA, this call would also short-circuit. It must remain
      // closed and invoke the operation normally.
      const succeedingOperation = jest.fn().mockResolvedValue('reserved');
      await expect(breakerB.execute(succeedingOperation)).resolves.toBe(
        'reserved',
      );
      expect(succeedingOperation).toHaveBeenCalledTimes(1);
      expect(loggerB.warn).not.toHaveBeenCalled();
    });
  });

  describe('audit isolation (transition never reaches audit trail)', () => {
    it('has no audit-shaped dependency in its constructor and no audit-shaped public method', () => {
      // The constructor accepts exactly one dependency: the injected
      // PinoLogger. `OutboxPollerService` is the only class in this codebase
      // that injects `AUDIT_TCP_CLIENT` (see orders.constants.ts /
      // outbox-poller.service.ts) — InventoryCircuitBreaker does not. If an
      // audit-shaped dependency were ever added to this constructor, this
      // arity check breaks immediately and forces a design review.
      expect(InventoryCircuitBreaker.length).toBe(1);

      // TS `private` is compile-time only, so this also covers every
      // internal transition method (`admit`, `tripOpen`, etc.), not just the
      // public `execute()` surface.
      const allMembers = Object.getOwnPropertyNames(
        InventoryCircuitBreaker.prototype,
      ).filter((name) => name !== 'constructor');

      expect(allMembers).toContain('execute');
      expect(allMembers.some((name) => /audit|mongo/i.test(name))).toBe(
        false,
      );
    });

    it('never touches anything beyond the injected logger across a full transition sweep', async () => {
      // Sweep: closed -> open (threshold) -> half-open (reset timeout
      // elapses) -> open again (failed trial) -> half-open -> closed
      // (successful trial). `logger` is the ONLY collaborator this instance
      // was constructed with, so asserting its calls never reference
      // anything audit-shaped is the strongest coupling check available
      // given the real DI graph — there is no audit client to spy on
      // because none is injected.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        jest.setSystemTime(0);
        const failing = jest
          .fn()
          .mockRejectedValue(new Error('ECONNREFUSED'));
        for (let i = 0; i < 5; i += 1) {
          await expect(breaker.execute(failing)).rejects.toThrow(
            'ECONNREFUSED',
          );
        }

        jest.setSystemTime(15_000);
        const failingTrial = jest
          .fn()
          .mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(breaker.execute(failingTrial)).rejects.toThrow(
          'ECONNREFUSED',
        );

        jest.setSystemTime(30_000);
        const succeedingTrial = jest.fn().mockResolvedValue('reserved');
        await expect(breaker.execute(succeedingTrial)).resolves.toBe(
          'reserved',
        );

        expect(logger.error).not.toHaveBeenCalled();
        const totalLogCalls =
          logger.warn.mock.calls.length + logger.info.mock.calls.length;
        expect(totalLogCalls).toBeGreaterThan(0);

        const serializedLogPayloads = JSON.stringify([
          ...logger.warn.mock.calls,
          ...logger.info.mock.calls,
        ]);
        expect(serializedLogPayloads.toLowerCase()).not.toContain('audit');
        expect(serializedLogPayloads.toLowerCase()).not.toContain('mongo');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
