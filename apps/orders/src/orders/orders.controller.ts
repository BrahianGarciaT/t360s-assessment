import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SearchOrdersDto } from './dto/search-orders.dto';
import { ApiKeyGuard } from '../guards/api-key.guard';

@ApiTags('orders')
@ApiSecurity('x-api-key')
@UseGuards(ApiKeyGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Crea una nueva orden con sus items' })
  @ApiResponse({ status: 201, description: 'Orden creada correctamente' })
  @ApiResponse({ status: 400, description: 'Datos de la orden inválidos' })
  @ApiResponse({ status: 401, description: 'API key inválida o ausente' })
  createOrder(@Body() dto: CreateOrderDto) {
    return this.ordersService.createOrder(dto);
  }

  @Get('search')
  @ApiOperation({ summary: 'Búsqueda full-text de órdenes por texto libre' })
  @ApiResponse({ status: 200, description: 'Resultados de la búsqueda' })
  @ApiResponse({ status: 400, description: 'Parámetros de búsqueda inválidos' })
  @ApiResponse({ status: 401, description: 'API key inválida o ausente' })
  searchOrders(@Query() dto: SearchOrdersDto) {
    return this.ordersService.searchOrders({ ...dto, q: dto.q.trim() });
  }

  @Get()
  @ApiOperation({ summary: 'Lista órdenes con filtros y paginación' })
  @ApiResponse({ status: 200, description: 'Listado paginado de órdenes' })
  @ApiResponse({ status: 400, description: 'Parámetros de consulta inválidos' })
  @ApiResponse({ status: 401, description: 'API key inválida o ausente' })
  findAll(@Query() query: QueryOrdersDto) {
    return this.ordersService.findAll(query);
  }

  @Put(':id/status')
  @ApiOperation({ summary: 'Actualiza el estado de una orden' })
  @ApiParam({ name: 'id', description: 'UUID de la orden' })
  @ApiResponse({ status: 200, description: 'Estado actualizado correctamente' })
  @ApiResponse({ status: 400, description: 'Transición de estado inválida' })
  @ApiResponse({ status: 401, description: 'API key inválida o ausente' })
  @ApiResponse({ status: 404, description: 'Orden no encontrada' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.ordersService.updateStatus(id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene el detalle de una orden por id' })
  @ApiParam({ name: 'id', description: 'UUID de la orden' })
  @ApiResponse({ status: 200, description: 'Detalle de la orden' })
  @ApiResponse({ status: 401, description: 'API key inválida o ausente' })
  @ApiResponse({ status: 404, description: 'Orden no encontrada' })
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }
}
