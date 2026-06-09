/**
 * Pure stock reservation logic.
 *
 * Real ATOMICITY (under inter-process concurrency) is the responsibility of the
 * StockPort/adapter (conditional Redis Lua DECRBY, or synchronous in-memory operation).
 * This function only expresses the RULE: reserve only if there is sufficient balance.
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
