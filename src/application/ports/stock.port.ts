export const STOCK_PORT = Symbol('STOCK_PORT');

export interface ReserveOutcome {
  ok: boolean;
  remaining: number;
}

/**
 * Porta de estoque com operações ATÔMICAS sob concorrência.
 * - redis: Lua DECRBY condicional.
 * - memory: operação síncrona (Node single-thread garante atomicidade por tick).
 */
export interface StockPort {
  /** Inicializa/define o saldo de um produto (seed). */
  init(productId: string, quantity: number): Promise<void>;
  get(productId: string): Promise<number>;
  /** Reserva atômica: decrementa só se houver saldo >= quantity. */
  reserve(productId: string, quantity: number): Promise<ReserveOutcome>;
  /** Compensação: devolve a quantidade ao saldo. */
  release(productId: string, quantity: number): Promise<void>;
}
