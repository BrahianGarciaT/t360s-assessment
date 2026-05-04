import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['x-api-key'];
    const apiKey = Array.isArray(raw) ? raw[0] : raw;
    const expectedKey = this.configService.get<string>('API_KEY');

    if (!apiKey) {
      throw new UnauthorizedException('Missing x-api-key header');
    }

    if (apiKey !== expectedKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
