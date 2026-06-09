export const STOCK_PORT = Symbol('STOCK_PORT');

export interface ReserveOutcome {
  ok: boolean;
  remaining: number;
}

/**
 * Stock port with ATOMIC operations under concurrency.
 * - redis: conditional Lua DECRBY.
 * - memory: synchronous operation (Node single-thread guarantees atomicity per tick).
 */
export interface StockPort {
  /** Initializes/sets the balance of a product (seed). */
  init(productId: string, quantity: number): Promise<void>;
  get(productId: string): Promise<number>;
  /** Atomic reservation: decrements only if balance >= quantity. */
  reserve(productId: string, quantity: number): Promise<ReserveOutcome>;
  /** Compensation: returns the quantity to the balance. */
  release(productId: string, quantity: number): Promise<void>;
}
