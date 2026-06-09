import type { Redis } from 'ioredis';
import {
  IdempotencyPort,
  IdempotencyRecord,
} from '../../application/ports/idempotency.port';

const KEY = (key: string) => `idem:${key}`;

/**
 * Redis dedupe store. `SET key value NX PX ttl` is atomic: if the key is new,
 * it writes and returns OK (created); if it already exists, returns null and we
 * read the persisted orderId (replay). Guarantees 1 order per Idempotency-Key.
 */
export class RedisIdempotencyAdapter implements IdempotencyPort {
  constructor(private readonly redis: Redis) {}

  async remember(
    key: string,
    orderId: string,
    ttlMs: number,
  ): Promise<IdempotencyRecord> {
    const ok = await this.redis.set(
      KEY(key),
      orderId,
      'PX',
      Math.max(1, ttlMs),
      'NX',
    );
    if (ok === 'OK') {
      return { orderId, created: true };
    }
    const existing = await this.redis.get(KEY(key));
    return { orderId: existing ?? orderId, created: false };
  }
}
