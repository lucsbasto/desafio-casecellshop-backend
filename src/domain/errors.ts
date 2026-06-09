/**
 * Domain errors. The interface layer (exception filter) translates them into
 * HTTP status codes, keeping the domain independent of HTTP.
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

/** Insufficient stock to reserve the requested quantity. -> HTTP 409 */
export class InsufficientStockError extends DomainError {
  constructor(productId: string) {
    super(`Estoque insuficiente para o produto ${productId}`, 'INSUFFICIENT_STOCK');
  }
}

/** Product not found in the catalog. -> HTTP 404 */
export class ProductNotFoundError extends DomainError {
  constructor(productId: string) {
    super(`Produto ${productId} não encontrado`, 'PRODUCT_NOT_FOUND');
  }
}

/** Order not found. -> HTTP 404 */
export class OrderNotFoundError extends DomainError {
  constructor(orderId: string) {
    super(`Pedido ${orderId} não encontrado`, 'ORDER_NOT_FOUND');
  }
}

/** Invalid status transition in the order state machine. -> HTTP 409 */
export class InvalidOrderTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Transição de status inválida: ${from} -> ${to}`, 'INVALID_ORDER_TRANSITION');
  }
}
