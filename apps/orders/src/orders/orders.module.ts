import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from '@app/shared';
import { Order } from './entities/order.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OrdersRepository } from './orders.repository';
import { OutboxRepository } from './outbox.repository';
import { OutboxPollerService } from './outbox-poller.service';
import { OutboxPurgeService } from './outbox-purge.service';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { AUDIT_TCP_CLIENT, INVENTORY_TCP_CLIENT } from './orders.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OutboxEvent]),
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
      {
        name: INVENTORY_TCP_CLIENT,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.get<string>('INVENTORY_TCP_HOST'),
            port: configService.get<number>('INVENTORY_TCP_PORT'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersRepository,
    OutboxRepository,
    OutboxPollerService,
    OutboxPurgeService,
    ApiKeyGuard,
  ],
})
export class OrdersModule {}
