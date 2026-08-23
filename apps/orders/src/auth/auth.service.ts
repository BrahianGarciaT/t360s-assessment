import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from '@app/shared';
import { UsersService } from '../users/users.service';
import { PasswordService } from '../users/password.service';
import { LoginDto } from './dto/login.dto';

// Mensaje idéntico para email desconocido y password incorrecto — evita
// enumeración de usuarios registrados (spec "Invalid credentials").
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const passwordMatches = await this.passwordService.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const payload: AuthUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    return { accessToken: await this.jwtService.signAsync(payload) };
  }
}
