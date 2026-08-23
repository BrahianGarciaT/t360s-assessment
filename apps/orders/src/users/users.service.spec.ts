import { ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Role } from '@app/shared';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';

describe('UsersService', () => {
  let repository: jest.Mocked<
    Pick<Repository<User>, 'findOne' | 'create' | 'save'>
  >;
  let service: UsersService;

  beforeEach(() => {
    repository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    service = new UsersService(repository as unknown as Repository<User>);
  });

  describe('findByEmail', () => {
    it('returns the user matching the given email', async () => {
      const user = {
        id: 'user-1',
        email: 'jane@example.com',
        passwordHash: 'hash',
        role: Role.CUSTOMER,
      } as User;
      repository.findOne.mockResolvedValue(user);

      const result = await service.findByEmail('jane@example.com');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { email: 'jane@example.com' },
      });
      expect(result).toBe(user);
    });

    it('returns null when no user matches the given email', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.findByEmail('ghost@example.com');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('persists a new user through the repository', async () => {
      const input = {
        email: 'new@example.com',
        passwordHash: 'hashed',
        role: Role.CUSTOMER,
      };
      const created = { ...input, id: 'user-2' } as User;
      repository.create.mockReturnValue(created);
      repository.save.mockResolvedValue(created);

      const result = await service.create(input);

      expect(repository.create).toHaveBeenCalledWith(input);
      expect(repository.save).toHaveBeenCalledWith(created);
      expect(result).toBe(created);
    });

    it('throws ConflictException when the repository rejects with a 23505 unique violation', async () => {
      const input = {
        email: 'duplicate@example.com',
        passwordHash: 'hashed',
        role: Role.CUSTOMER,
      };
      repository.create.mockReturnValue(input as User);
      repository.save.mockRejectedValue({ code: '23505' });

      await expect(service.create(input)).rejects.toThrow(ConflictException);
    });

    it('rethrows an unrelated repository error unchanged', async () => {
      const input = {
        email: 'other@example.com',
        passwordHash: 'hashed',
        role: Role.CUSTOMER,
      };
      const unrelatedError = new Error('connection lost');
      repository.create.mockReturnValue(input as User);
      repository.save.mockRejectedValue(unrelatedError);

      await expect(service.create(input)).rejects.toBe(unrelatedError);
    });
  });
});
