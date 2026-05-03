import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './orders/entities/order.entity';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('ORDERS_DB_HOST'),
        port: configService.get<number>('ORDERS_DB_PORT'),
        username: configService.get<string>('ORDERS_DB_USER'),
        password: configService.get<string>('ORDERS_DB_PASSWORD'),
        database: configService.get<string>('ORDERS_DB_NAME'),
        entities: [Order],
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    OrdersModule,
  ],
})
export class AppModule {}
