import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { PasswordService } from './password.service';
import { UsersSeederService } from './users-seeder.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService, PasswordService, UsersSeederService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}
