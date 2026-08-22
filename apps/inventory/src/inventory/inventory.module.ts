import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StockItem } from './entities/stock-item.entity';
import { Reservation } from './entities/reservation.entity';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { ReservationReaperService } from './reservation-reaper.service';
import { AUDIT_TCP_CLIENT } from './inventory.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([StockItem, Reservation]),
    ScheduleModule.forRoot(),
    ClientsModule.registerAsync([
      {
        name: AUDIT_TCP_CLIENT,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.get<string>('AUDIT_TCP_HOST'),
            port: configService.get<number>('AUDIT_TCP_PORT'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService, ReservationReaperService],
})
export class InventoryModule {}
