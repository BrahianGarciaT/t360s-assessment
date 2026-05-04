import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { SearchOrdersDto } from './dto/search-orders.dto';
import { ApiKeyGuard } from '../guards/api-key.guard';

@UseGuards(ApiKeyGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  createOrder(@Body() dto: CreateOrderDto) {
    return this.ordersService.createOrder(dto);
  }

  @Get('search')
  searchOrders(
    @Query(new ValidationPipe({ transform: true })) dto: SearchOrdersDto,
  ) {
    return this.ordersService.searchOrders({ ...dto, q: dto.q.trim() });
  }

  @Get()
  findAll(@Query(new ValidationPipe({ transform: true })) query: QueryOrdersDto) {
    return this.ordersService.findAll(query);
  }

  @Put(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.ordersService.updateStatus(id, dto);
  }
}
