import {
  IdempotencyPort,
  IdempotencyRecord,
} from '../../application/ports/idempotency.port';

interface Stored {
  orderId: string;
  expiresAt: number;
}

/**
 * Dedupe store in-memory. `remember` é síncrono na seção crítica (sem await
 * entre checar e gravar) => atômico no Node. Equivalente ao SET NX EX do Redis.
 */
export class InMemoryIdempotencyAdapter implements IdempotencyPort {
  private readonly store = new Map<string, Stored>();

  async remember(
    key: string,
    orderId: string,
    ttlMs: number,
  ): Promise<IdempotencyRecord> {
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) {
      return { orderId: existing.orderId, created: false };
    }
    this.store.set(key, { orderId, expiresAt: now + ttlMs });
    return { orderId, created: true };
  }
}
