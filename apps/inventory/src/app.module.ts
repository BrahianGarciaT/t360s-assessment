import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { createPinoLoggerOptions } from '@app/shared';
import { StockItem } from './inventory/entities/stock-item.entity';
import { Reservation } from './inventory/entities/reservation.entity';
import { InventoryModule } from './inventory/inventory.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    LoggerModule.forRoot(createPinoLoggerOptions('inventory')),
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('INVENTORY_DB_HOST'),
        port: configService.get<number>('INVENTORY_DB_PORT'),
        username: configService.get<string>('INVENTORY_DB_USER'),
        password: configService.get<string>('INVENTORY_DB_PASSWORD'),
        database: configService.get<string>('INVENTORY_DB_NAME'),
        entities: [StockItem, Reservation],
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    InventoryModule,
    HealthModule,
  ],
})
export class AppModule {}
