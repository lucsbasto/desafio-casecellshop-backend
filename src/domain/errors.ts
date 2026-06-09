/**
 * Erros de domínio. A camada de interface (exception filter) os traduz para
 * códigos HTTP, mantendo o domínio independente de HTTP.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Estoque insuficiente para reservar a quantidade pedida. -> HTTP 409 */
export class InsufficientStockError extends DomainError {
  constructor(productId: string) {
    super(`Estoque insuficiente para o produto ${productId}`, 'INSUFFICIENT_STOCK');
  }
}

/** Produto não encontrado no catálogo. -> HTTP 404 */
export class ProductNotFoundError extends DomainError {
  constructor(productId: string) {
    super(`Produto ${productId} não encontrado`, 'PRODUCT_NOT_FOUND');
  }
}

/** Pedido não encontrado. -> HTTP 404 */
export class OrderNotFoundError extends DomainError {
  constructor(orderId: string) {
    super(`Pedido ${orderId} não encontrado`, 'ORDER_NOT_FOUND');
  }
}

/** Transição de status inválida na máquina de estados do pedido. -> HTTP 409 */
export class InvalidOrderTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Transição de status inválida: ${from} -> ${to}`, 'INVALID_ORDER_TRANSITION');
  }
}
