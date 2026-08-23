import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@app/shared';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PasswordService } from '../users/password.service';
import { User } from '../users/entities/user.entity';

describe('AuthService', () => {
  let usersService: jest.Mocked<Pick<UsersService, 'findByEmail'>>;
  let passwordService: jest.Mocked<Pick<PasswordService, 'compare'>>;
  let jwtService: jest.Mocked<Pick<JwtService, 'signAsync'>>;
  let service: AuthService;

  const user = {
    id: 'user-1',
    email: 'jane@example.com',
    passwordHash: 'hashed-password',
    role: Role.CUSTOMER,
  } as User;

  beforeEach(() => {
    usersService = { findByEmail: jest.fn() };
    passwordService = { compare: jest.fn() };
    jwtService = { signAsync: jest.fn() };
    service = new AuthService(
      usersService as unknown as UsersService,
      passwordService as unknown as PasswordService,
      jwtService as unknown as JwtService,
    );
  });

  it('throws UnauthorizedException for an unknown email', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await expect(
      service.login({ email: 'ghost@example.com', password: 'anything' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException with the same message for an unknown email and a wrong password (no user enumeration)', async () => {
    usersService.findByEmail.mockResolvedValueOnce(null);
    let unknownEmailMessage = '';
    try {
      await service.login({ email: 'ghost@example.com', password: 'x' });
    } catch (error) {
      unknownEmailMessage = (error as UnauthorizedException).message;
    }

    usersService.findByEmail.mockResolvedValueOnce(user);
    passwordService.compare.mockResolvedValueOnce(false);
    let wrongPasswordMessage = '';
    try {
      await service.login({ email: user.email, password: 'wrong' });
    } catch (error) {
      wrongPasswordMessage = (error as UnauthorizedException).message;
    }

    expect(unknownEmailMessage.length).toBeGreaterThan(0);
    expect(wrongPasswordMessage).toBe(unknownEmailMessage);
  });

  it('returns a signed access token with sub/email/role claims on valid credentials', async () => {
    usersService.findByEmail.mockResolvedValue(user);
    passwordService.compare.mockResolvedValue(true);
    jwtService.signAsync.mockResolvedValue('signed-jwt-token');

    const result = await service.login({
      email: user.email,
      password: 'correct-password',
    });

    expect(passwordService.compare).toHaveBeenCalledWith(
      'correct-password',
      user.passwordHash,
    );
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    expect(result).toEqual({ accessToken: 'signed-jwt-token' });
  });
});
