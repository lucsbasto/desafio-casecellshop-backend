import type { Redis } from 'ioredis';
import { ReserveOutcome, StockPort } from '../../application/ports/stock.port';

const KEY = (productId: string) => `stock:${productId}`;

/**
 * Redis stock with ATOMIC reservation via Lua script: the check-and-decrement
 * runs as a single atomic operation on the Redis server, eliminating TOCTOU
 * even across multiple application instances.
 */
export class RedisStockAdapter implements StockPort {
  // KEYS[1]=stock key, ARGV[1]=quantity. Returns [ok(0|1), balance].
  private static readonly RESERVE_LUA = `
    local current = tonumber(redis.call('GET', KEYS[1]) or '0')
    local qty = tonumber(ARGV[1])
    if qty <= 0 then return {0, current} end
    if current < qty then return {0, current} end
    local remaining = redis.call('DECRBY', KEYS[1], qty)
    return {1, remaining}
  `;

  constructor(private readonly redis: Redis) {}

  async init(productId: string, quantity: number): Promise<void> {
    await this.redis.set(KEY(productId), String(quantity));
  }

  async get(productId: string): Promise<number> {
    const v = await this.redis.get(KEY(productId));
    return v === null ? 0 : Number(v);
  }

  async reserve(productId: string, quantity: number): Promise<ReserveOutcome> {
    const [ok, remaining] = (await this.redis.eval(
      RedisStockAdapter.RESERVE_LUA,
      1,
      KEY(productId),
      String(quantity),
    )) as [number, number];
    return { ok: ok === 1, remaining: Number(remaining) };
  }

  async release(productId: string, quantity: number): Promise<void> {
    await this.redis.incrby(KEY(productId), Math.max(0, quantity));
  }
}
