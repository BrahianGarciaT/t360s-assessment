import { ExecutionContext } from '@nestjs/common';
import { getCurrentUserByContext } from './current-user.decorator';
import { Role } from '../enums/role.enum';
import { AuthUser } from '../auth/jwt-payload.interface';

describe('getCurrentUserByContext', () => {
  const createContext = (user: AuthUser | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as unknown as ExecutionContext;

  it('returns request.user when it is set by JwtAuthGuard', () => {
    const user: AuthUser = {
      sub: 'user-1',
      email: 'a@b.com',
      role: Role.CUSTOMER,
    };
    const context = createContext(user);

    expect(getCurrentUserByContext(context)).toEqual(user);
  });

  it('returns undefined when request.user is not set', () => {
    const context = createContext(undefined);

    expect(getCurrentUserByContext(context)).toBeUndefined();
  });
});
