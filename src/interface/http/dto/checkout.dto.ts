import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '../../../domain/order';

export class CheckoutItemDto {
  @ApiProperty({ example: 'CAPA-001' })
  @IsString()
  productId!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @IsInt()
  @IsPositive()
  @Min(1)
  quantity!: number;
}

export class CheckoutRequestDto {
  @ApiProperty({ type: [CheckoutItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}

export class CheckoutAcceptedDto {
  @ApiProperty({ example: 'a1b2c3d4-...', description: 'ID do pedido criado' })
  orderId!: string;

  @ApiProperty({ enum: OrderStatus, example: OrderStatus.PENDING })
  status!: OrderStatus;

  @ApiProperty({
    example: false,
    description: 'true se a resposta veio de uma requisição idempotente repetida',
  })
  replay!: boolean;
}
