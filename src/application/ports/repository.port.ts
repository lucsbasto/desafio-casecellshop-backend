import { Order } from '../../domain/order';
import { Product } from '../../domain/product';

export const PRODUCT_REPO_PORT = Symbol('PRODUCT_REPO_PORT');
export const ORDER_REPO_PORT = Symbol('ORDER_REPO_PORT');

/**
 * Repositório de produtos = "ERP fake" (origem da verdade de produto/preço).
 * Simula latência de uma API REST síncrona do ERP.
 */
export interface ProductRepositoryPort {
  findAll(): Promise<Product[]>;
  findById(id: string): Promise<Product | undefined>;
}

/** Persistência de pedidos (read model da loja). */
export interface OrderRepositoryPort {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
  /** Pedidos PENDING criados antes de `before` (para reconciliação). */
  findPendingOlderThan(before: Date): Promise<Order[]>;
}
