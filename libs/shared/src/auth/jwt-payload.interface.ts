import { Role } from '../enums/role.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  iat?: number;
  exp?: number;
}

export type AuthUser = Pick<JwtPayload, 'sub' | 'email' | 'role'>;
