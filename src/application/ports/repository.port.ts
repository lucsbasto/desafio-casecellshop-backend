import { Order } from '../../domain/order';
import { Product } from '../../domain/product';

export const PRODUCT_REPO_PORT = Symbol('PRODUCT_REPO_PORT');
export const ORDER_REPO_PORT = Symbol('ORDER_REPO_PORT');

/**
 * Product repository = "fake ERP" (source of truth for product/price).
 * Simulates the latency of a synchronous ERP REST API.
 */
export interface ProductRepositoryPort {
  findAll(): Promise<Product[]>;
  findById(id: string): Promise<Product | undefined>;
}

/** Order persistence (store read model). */
export interface OrderRepositoryPort {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
  /** PENDING orders created before `before` (for reconciliation). */
  findPendingOlderThan(before: Date): Promise<Order[]>;
}
