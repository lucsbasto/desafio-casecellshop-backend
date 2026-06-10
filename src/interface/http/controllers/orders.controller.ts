import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GetOrderStatusUseCase } from '../../../application/use-cases/get-order-status.usecase';
import { ErrorDto } from '../dto/error.dto';
import { OrderStatusDto } from '../dto/order.dto';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly getStatus: GetOrderStatusUseCase) {}

  @Get(':orderId/status')
  @ApiOkResponse({ type: OrderStatusDto, description: 'Status e histórico do pedido' })
  @ApiNotFoundResponse({ type: ErrorDto })
  @ApiInternalServerErrorResponse({ type: ErrorDto, description: 'Erro interno inesperado' })
  async status(@Param('orderId') orderId: string): Promise<OrderStatusDto> {
    const order = await this.getStatus.execute(orderId);
    return {
      id: order.id,
      status: order.status,
      items: order.items,
      totalCents: order.totalCents,
      history: order.history,
      attempts: order.attempts,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
