import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiTags,
} from '@nestjs/swagger';
import { CheckoutUseCase } from '../../../application/use-cases/checkout.usecase';
import { getCorrelationId } from '../../../observability/correlation';
import { CheckoutAcceptedDto, CheckoutRequestDto } from '../dto/checkout.dto';
import { ErrorDto } from '../dto/error.dto';

@ApiTags('checkout')
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutUseCase) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Chave de idempotência. Reenvios com a mesma chave retornam o mesmo pedido (tolera retry/duplo clique).',
  })
  @ApiAcceptedResponse({
    type: CheckoutAcceptedDto,
    description: '202 Accepted: pedido criado (PENDING) e enfileirado para processamento.',
  })
  @ApiBadRequestResponse({ type: ErrorDto, description: 'Payload inválido' })
  @ApiConflictResponse({
    type: ErrorDto,
    description: 'Estoque insuficiente ou requisição duplicada',
  })
  async start(
    @Body() body: CheckoutRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CheckoutAcceptedDto> {
    const { order, replay } = await this.checkout.execute({
      items: body.items,
      idempotencyKey,
      correlationId: getCorrelationId() ?? 'unknown',
    });
    return { orderId: order.id, status: order.status, replay };
  }
}
