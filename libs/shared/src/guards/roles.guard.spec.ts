import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role } from '../enums/role.enum';
import { AuthUser } from '../auth/jwt-payload.interface';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: jest.Mock };

  const createContext = (user: AuthUser | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows the request when no @Roles metadata is declared', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const context = createContext({
      sub: 'user-1',
      email: 'a@b.com',
      role: Role.CUSTOMER,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws ForbiddenException when the user role does not match required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.OPERATOR]);
    const context = createContext({
      sub: 'user-1',
      email: 'a@b.com',
      role: Role.CUSTOMER,
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows the request when the user role matches a required role', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.OPERATOR]);
    const context = createContext({
      sub: 'user-1',
      email: 'a@b.com',
      role: Role.OPERATOR,
    });

    expect(guard.canActivate(context)).toBe(true);
  });
});
