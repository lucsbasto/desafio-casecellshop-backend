import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '../../../domain/order';

export class CheckoutItemDto {
  @ApiProperty({ example: 'CAPA-001', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' })
  @IsString()
  @MaxLength(64)
  // Bounded charset: productId flows straight into Redis keys (stock:/products:).
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'productId deve conter apenas [A-Za-z0-9_-]' })
  productId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 1000 })
  @IsInt()
  @IsPositive()
  @Min(1)
  @Max(1000)
  quantity!: number;
}

export class CheckoutRequestDto {
  @ApiProperty({ type: [CheckoutItemDto], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  // Caps fan-out: each item triggers a repo lookup + stock reservation.
  @ArrayMaxSize(50)
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
