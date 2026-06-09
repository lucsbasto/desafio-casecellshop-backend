import { ReserveOutcome, StockPort } from '../../application/ports/stock.port';
import { tryReserve, release } from '../../domain/stock';

/**
 * Estoque in-memory. O Node é single-thread: cada `reserve` executa de forma
 * síncrona e atômica dentro de um tick — não há await entre o check e o
 * decremento — então N reserves concorrentes via Promise.all não causam race.
 * É o equivalente in-memory ao DECRBY condicional do Redis.
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
    // Seção crítica síncrona: sem await entre leitura e escrita => atômica.
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
