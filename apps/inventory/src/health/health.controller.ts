import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
  HealthCheck,
} from '@nestjs/terminus';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary:
      'Reporta el estado del servicio y su conexión a Postgres, indicando la causa cuando no está saludable',
  })
  check() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }
}
