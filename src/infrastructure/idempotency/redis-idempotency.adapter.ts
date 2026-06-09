import type { Redis } from 'ioredis';
import {
  IdempotencyPort,
  IdempotencyRecord,
} from '../../application/ports/idempotency.port';

const KEY = (key: string) => `idem:${key}`;

/**
 * Dedupe store em Redis. `SET key value NX PX ttl` é atômico: se a chave é nova,
 * grava e retorna OK (created); se já existe, retorna null e lemos o orderId
 * persistido (replay). Garante 1 pedido por Idempotency-Key.
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
