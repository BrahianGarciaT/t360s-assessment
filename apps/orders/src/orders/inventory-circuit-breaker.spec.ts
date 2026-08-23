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
});
