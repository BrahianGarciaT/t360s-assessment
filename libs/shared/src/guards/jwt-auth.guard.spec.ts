import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Role } from '../enums/role.enum';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: { verifyAsync: jest.Mock };
  let request: {
    headers: Record<string, string | string[] | undefined>;
    user?: unknown;
  };

  const createContext = (
    headers: Record<string, string | string[] | undefined>,
  ): ExecutionContext => {
    request = { headers };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    guard = new JwtAuthGuard(jwtService as unknown as JwtService);
  });

  it('throws UnauthorizedException when the Authorization header is missing', async () => {
    const context = createContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when the Authorization header does not use the Bearer scheme', async () => {
    const context = createContext({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when the Bearer token is empty', async () => {
    const context = createContext({ authorization: 'Bearer ' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when the token is expired', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const context = createContext({ authorization: 'Bearer expired-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when the token has a bad signature', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    const context = createContext({ authorization: 'Bearer bad-sig-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('sets request.user and allows the request when the token is valid', async () => {
    const payload = { sub: 'user-1', email: 'a@b.com', role: Role.CUSTOMER };
    jwtService.verifyAsync.mockResolvedValue(payload);
    const context = createContext({ authorization: 'Bearer valid-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(payload);
  });
});
