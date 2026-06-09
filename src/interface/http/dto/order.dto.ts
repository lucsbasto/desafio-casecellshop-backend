import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../../domain/order';

export class OrderTransitionDto {
  @ApiProperty({ enum: OrderStatus })
  status!: OrderStatus;

  @ApiProperty({ example: '2026-06-09T03:00:00.000Z' })
  at!: string;

  @ApiProperty({ required: false, example: 'tentativa 1' })
  reason?: string;
}

export class OrderItemDto {
  @ApiProperty({ example: 'CAPA-001' })
  productId!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;
}

export class OrderStatusDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: OrderStatus })
  status!: OrderStatus;

  @ApiProperty({ type: [OrderItemDto] })
  items!: OrderItemDto[];

  @ApiProperty({ example: 9980 })
  totalCents!: number;

  @ApiProperty({ type: [OrderTransitionDto] })
  history!: OrderTransitionDto[];

  @ApiProperty({ example: 1 })
  attempts!: number;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}
