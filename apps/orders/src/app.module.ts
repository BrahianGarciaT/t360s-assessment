import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { createPinoLoggerOptions } from '@app/shared';
import { Order } from './orders/entities/order.entity';
import { OutboxEvent } from './orders/entities/outbox-event.entity';
import { OrdersModule } from './orders/orders.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    LoggerModule.forRoot(createPinoLoggerOptions('orders')),
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('THROTTLE_TTL', 60000),
          limit: configService.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
      inject: [ConfigService],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('ORDERS_DB_HOST'),
        port: configService.get<number>('ORDERS_DB_PORT'),
        username: configService.get<string>('ORDERS_DB_USER'),
        password: configService.get<string>('ORDERS_DB_PASSWORD'),
        database: configService.get<string>('ORDERS_DB_NAME'),
        entities: [Order, OutboxEvent],
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    OrdersModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
