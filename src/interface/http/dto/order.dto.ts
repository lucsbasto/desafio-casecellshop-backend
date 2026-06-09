import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../../domain/order';

export class OrderTransitionDto {
  @ApiProperty({ enum: OrderStatus })
  readonly status!: OrderStatus;

  @ApiProperty({ example: '2026-06-09T03:00:00.000Z' })
  readonly at!: string;

  @ApiProperty({ required: false, example: 'tentativa 1' })
  readonly reason?: string;
}

export class OrderItemDto {
  @ApiProperty({ example: 'CAPA-001' })
  readonly productId!: string;

  @ApiProperty({ example: 2 })
  readonly quantity!: number;
}

export class OrderStatusDto {
  @ApiProperty()
  readonly id!: string;

  @ApiProperty({ enum: OrderStatus })
  readonly status!: OrderStatus;

  @ApiProperty({ type: [OrderItemDto] })
  readonly items!: OrderItemDto[];

  @ApiProperty({ example: 9980 })
  readonly totalCents!: number;

  @ApiProperty({ type: [OrderTransitionDto] })
  readonly history!: OrderTransitionDto[];

  @ApiProperty({ example: 1 })
  readonly attempts!: number;

  @ApiProperty()
  readonly createdAt!: string;

  @ApiProperty()
  readonly updatedAt!: string;
}
