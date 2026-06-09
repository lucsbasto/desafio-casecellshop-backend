import { IdempotencyPort, IdempotencyRecord } from '../../application/ports/idempotency.port';

interface Stored {
  orderId: string;
  expiresAt: number;
}

/**
 * In-memory dedupe store. `remember` is synchronous in the critical section (no
 * await between check and write) => atomic in Node. Equivalent to Redis SET NX EX.
 */
export class InMemoryIdempotencyAdapter implements IdempotencyPort {
  private readonly store = new Map<string, Stored>();

  async remember(key: string, orderId: string, ttlMs: number): Promise<IdempotencyRecord> {
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) {
      return { orderId: existing.orderId, created: false };
    }
    this.store.set(key, { orderId, expiresAt: now + ttlMs });
    return { orderId, created: true };
  }
}
