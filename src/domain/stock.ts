/**
 * Lógica pura de reserva de estoque.
 *
 * A ATOMICIDADE real (sob concorrência entre processos) é responsabilidade do
 * StockPort/adapter (Redis Lua DECRBY condicional, ou operação síncrona in-memory).
 * Esta função só expressa a REGRA: só reserva se houver saldo suficiente.
 */
export interface ReservationResult {
  ok: boolean;
  remaining: number;
}

export function tryReserve(current: number, quantity: number): ReservationResult {
  if (quantity <= 0) return { ok: false, remaining: current };
  if (current < quantity) return { ok: false, remaining: current };
  return { ok: true, remaining: current - quantity };
}

export function release(current: number, quantity: number): number {
  return current + Math.max(0, quantity);
}
