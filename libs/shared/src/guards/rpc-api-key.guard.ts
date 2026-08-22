import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { secureCompare } from '../utils/secure-compare';

/**
 * Equivalente a ApiKeyGuard para transporte TCP (@MessagePattern): no hay
 * headers HTTP en RPC, así que la key viaja como campo `apiKey` dentro del
 * propio payload del mensaje.
 */
@Injectable()
export class RpcApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const data = context.switchToRpc().getData<{ apiKey?: string }>();
    const expectedKey = this.configService.get<string>('API_KEY', '');

    if (!data?.apiKey) {
      throw new UnauthorizedException('Missing apiKey in message payload');
    }

    if (!secureCompare(data.apiKey, expectedKey)) {
      throw new UnauthorizedException('Invalid apiKey');
    }

    return true;
  }
}
