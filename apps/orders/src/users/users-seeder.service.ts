import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Role } from '@app/shared';
import { UsersService } from './users.service';
import { PasswordService } from './password.service';

interface SeedUserSpec {
  email: string;
  password: string;
  role: Role;
}

/**
 * Provisiona idempotentemente un usuario operator y un customer de
 * fixture al arrancar `orders`, para tener credenciales reales listas
 * para login/e2e sin un flujo de registro manual previo.
 */
@Injectable()
export class UsersSeederService implements OnApplicationBootstrap {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly configService: ConfigService,
    @InjectPinoLogger(UsersSeederService.name)
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const spec of this.getSeedSpecs()) {
      await this.seedUser(spec);
    }
  }

  private getSeedSpecs(): SeedUserSpec[] {
    return [
      {
        email: this.configService.get<string>(
          'SEED_OPERATOR_EMAIL',
          'operator@example.com',
        ),
        password: this.configService.get<string>(
          'SEED_OPERATOR_PASSWORD',
          'Operator123',
        ),
        role: Role.OPERATOR,
      },
      {
        email: this.configService.get<string>(
          'SEED_CUSTOMER_EMAIL',
          'customer@example.com',
        ),
        password: this.configService.get<string>(
          'SEED_CUSTOMER_PASSWORD',
          'Customer123',
        ),
        role: Role.CUSTOMER,
      },
    ];
  }

  private async seedUser(spec: SeedUserSpec): Promise<void> {
    const existing = await this.usersService.findByEmail(spec.email);

    if (existing) {
      return;
    }

    const passwordHash = await this.passwordService.hash(spec.password);
    await this.usersService.create({
      email: spec.email,
      passwordHash,
      role: spec.role,
    });
    this.logger.info({ email: spec.email }, 'Seeded fixture user');
  }
}
