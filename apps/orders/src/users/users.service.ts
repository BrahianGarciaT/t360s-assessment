import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '@app/shared';
import { User } from './entities/user.entity';

// SQLSTATE de violación de unicidad de Postgres (se lanza sobre el índice único users.email).
const POSTGRES_UNIQUE_VIOLATION_ERROR_CODE = '23505';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role: Role;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly repository: Repository<User>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.repository.findOne({ where: { email } });
  }

  async create(input: CreateUserInput): Promise<User> {
    try {
      return await this.repository.save(this.repository.create(input));
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION_ERROR_CODE
    );
  }
}
