import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';

describe('ApiKeyGuard', () => {
  const VALID_API_KEY = 'super-secret-key';

  let guard: ApiKeyGuard;
  let configService: { get: jest.Mock };

  const createContext = (
    headers: Record<string, string | string[] | undefined>,
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue(VALID_API_KEY),
    };
    guard = new ApiKeyGuard(configService as unknown as ConfigService);
  });

  it('throws UnauthorizedException when the x-api-key header is missing', () => {
    const context = createContext({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when the x-api-key header is incorrect', () => {
    const context = createContext({ 'x-api-key': 'wrong-key' });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('returns true when the x-api-key header matches the configured key', () => {
    const context = createContext({ 'x-api-key': VALID_API_KEY });

    expect(guard.canActivate(context)).toBe(true);
  });
});
