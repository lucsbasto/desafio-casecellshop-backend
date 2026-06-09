import { Inject, Injectable } from '@nestjs/common';
import {
  ORDER_REPO_PORT,
  OrderRepositoryPort,
} from '../ports/repository.port';
import { Order } from '../../domain/order';
import { OrderNotFoundError } from '../../domain/errors';

@Injectable()
export class GetOrderStatusUseCase {
  constructor(
    @Inject(ORDER_REPO_PORT) private readonly orders: OrderRepositoryPort,
  ) {}

  async execute(orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }
}
