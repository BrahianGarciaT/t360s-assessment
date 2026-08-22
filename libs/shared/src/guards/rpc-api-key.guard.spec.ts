import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcApiKeyGuard } from './rpc-api-key.guard';

describe('RpcApiKeyGuard', () => {
  const VALID_API_KEY = 'super-secret-key';

  let guard: RpcApiKeyGuard;
  let configService: { get: jest.Mock };

  const createContext = (data: Record<string, unknown>): ExecutionContext =>
    ({
      switchToRpc: () => ({
        getData: () => data,
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue(VALID_API_KEY),
    };
    guard = new RpcApiKeyGuard(configService as unknown as ConfigService);
  });

  it('throws UnauthorizedException when apiKey is missing from the payload', () => {
    const context = createContext({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when apiKey is incorrect', () => {
    const context = createContext({ apiKey: 'wrong-key' });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('returns true when apiKey matches the configured key', () => {
    const context = createContext({ apiKey: VALID_API_KEY });

    expect(guard.canActivate(context)).toBe(true);
  });
});
