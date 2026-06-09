import type { Redis } from 'ioredis';
import { IdempotencyPort, IdempotencyRecord } from '../../application/ports/idempotency.port';

const KEY = (key: string) => `idem:${key}`;

/**
 * Atomically SET NX PX and read back the stored value in one round-trip.
 * Returns {1, value} when created, {0, value} on replay. A single SET+GET would
 * have a TOCTOU window (key could expire between the two calls), which could
 * return the wrong orderId; the script closes that gap.
 */
const REMEMBER_LUA = `
  local created = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
  local val = redis.call('GET', KEYS[1])
  if created then return {1, val} else return {0, val} end
`;

/**
 * Redis dedupe store guaranteeing 1 order per Idempotency-Key. Uses an atomic
 * Lua script (SET NX + GET) so concurrent retries can never observe a stale or
 * missing value between the write and the read-back.
 */
export class RedisIdempotencyAdapter implements IdempotencyPort {
  constructor(private readonly redis: Redis) {}

  async remember(key: string, orderId: string, ttlMs: number): Promise<IdempotencyRecord> {
    const [created, existing] = (await this.redis.eval(
      REMEMBER_LUA,
      1,
      KEY(key),
      orderId,
      String(Math.max(1, ttlMs)),
    )) as [number, string | null];
    return { orderId: existing ?? orderId, created: created === 1 };
  }
}
