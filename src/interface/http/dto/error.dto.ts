import { ApiProperty } from '@nestjs/swagger';

/** Standardized error schema (both success and error cases documented in OpenAPI). */
export class ErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'INSUFFICIENT_STOCK' })
  error!: string;

  @ApiProperty({ example: 'Estoque insuficiente para o produto CAPA-003' })
  message!: string;

  @ApiProperty({ example: 'b7e2...-correlation-id' })
  correlationId!: string;

  @ApiProperty({ example: '2026-06-09T03:00:00.000Z' })
  timestamp!: string;
}
