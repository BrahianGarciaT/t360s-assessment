import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const configService = app.get(ConfigService);
  const port = configService.get<number>('ORDERS_HTTP_PORT') ?? 3000;

  await app.listen(port);
}

bootstrap();
