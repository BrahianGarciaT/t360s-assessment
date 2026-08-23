import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { Role } from '@app/shared';
import { UsersSeederService } from './users-seeder.service';
import { UsersService } from './users.service';
import { PasswordService } from './password.service';
import { User } from './entities/user.entity';

describe('UsersSeederService', () => {
  let usersService: jest.Mocked<Pick<UsersService, 'findByEmail' | 'create'>>;
  let passwordService: jest.Mocked<Pick<PasswordService, 'hash'>>;
  let configService: { get: jest.Mock };
  let logger: { info: jest.Mock };
  let seeder: UsersSeederService;

  const envValues: Record<string, string> = {
    SEED_OPERATOR_EMAIL: 'ops@example.com',
    SEED_OPERATOR_PASSWORD: 'OpPass123',
    SEED_CUSTOMER_EMAIL: 'cust@example.com',
    SEED_CUSTOMER_PASSWORD: 'CustPass123',
  };

  beforeEach(() => {
    usersService = { findByEmail: jest.fn(), create: jest.fn() };
    passwordService = { hash: jest.fn().mockResolvedValue('hashed-pw') };
    logger = { info: jest.fn() };
    configService = {
      get: jest.fn(
        (key: string, defaultValue?: string) => envValues[key] ?? defaultValue,
      ),
    };
    seeder = new UsersSeederService(
      usersService as unknown as UsersService,
      passwordService as unknown as PasswordService,
      configService as unknown as ConfigService,
      logger as unknown as PinoLogger,
    );
  });

  it('creates the operator and fixture customer on first bootstrap when neither exists', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await seeder.onApplicationBootstrap();

    expect(usersService.create).toHaveBeenCalledWith({
      email: 'ops@example.com',
      passwordHash: 'hashed-pw',
      role: Role.OPERATOR,
    });
    expect(usersService.create).toHaveBeenCalledWith({
      email: 'cust@example.com',
      passwordHash: 'hashed-pw',
      role: Role.CUSTOMER,
    });
    expect(usersService.create).toHaveBeenCalledTimes(2);
  });

  it('creates nothing on a second bootstrap when both fixture users already exist (idempotency)', async () => {
    usersService.findByEmail.mockResolvedValue({ id: 'existing-user' } as User);

    await seeder.onApplicationBootstrap();

    expect(usersService.create).not.toHaveBeenCalled();
  });
});
