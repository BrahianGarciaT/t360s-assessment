import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
