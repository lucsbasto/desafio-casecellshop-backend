import { ReserveOutcome, StockPort } from '../../application/ports/stock.port';
import { tryReserve, release } from '../../domain/stock';

/**
 * In-memory stock. Node is single-threaded: each `reserve` executes synchronously
 * and atomically within a tick — there is no await between the check and the
 * decrement — so N concurrent reserves via Promise.all do not cause a race condition.
 * This is the in-memory equivalent of Redis's conditional DECRBY.
 */
export class InMemoryStockAdapter implements StockPort {
  private readonly stock = new Map<string, number>();

  async init(productId: string, quantity: number): Promise<void> {
    this.stock.set(productId, quantity);
  }

  async get(productId: string): Promise<number> {
    return this.stock.get(productId) ?? 0;
  }

  async reserve(productId: string, quantity: number): Promise<ReserveOutcome> {
    // Synchronous critical section: no await between read and write => atomic.
    const current = this.stock.get(productId) ?? 0;
    const result = tryReserve(current, quantity);
    if (result.ok) {
      this.stock.set(productId, result.remaining);
    }
    return { ok: result.ok, remaining: result.remaining };
  }

  async release(productId: string, quantity: number): Promise<void> {
    const current = this.stock.get(productId) ?? 0;
    this.stock.set(productId, release(current, quantity));
  }
}
