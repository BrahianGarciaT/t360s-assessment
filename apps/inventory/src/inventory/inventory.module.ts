import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { StockItem } from './entities/stock-item.entity';
import { Reservation } from './entities/reservation.entity';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { ReservationReaperService } from './reservation-reaper.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StockItem, Reservation]),
    ScheduleModule.forRoot(),
  ],
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService, ReservationReaperService],
})
export class InventoryModule {}
