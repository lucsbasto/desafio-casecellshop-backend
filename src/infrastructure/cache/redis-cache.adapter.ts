import type { Redis } from 'ioredis';
import { CachePort } from '../../application/ports/cache.port';

/**
 * Redis cache (cache-aside). In-process single-flight + TTL jitter mitigate
 * stampede; for cross-instance coordination a short SET NX lock would be used
 * (referenced in the README). Keeps the last value for stale-while-error fallback.
 */
export class RedisCacheAdapter implements CachePort {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly lastKnown = new Map<string, unknown>();

  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupted/foreign value: treat as a miss and evict the bad key instead
      // of letting a SyntaxError bubble up and surface as a 500.
      await this.redis.del(key);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'PX', Math.max(1, ttlMs));
    this.lastKnown.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { staleOnError?: boolean } = {},
  ): Promise<{ value: T; hit: boolean; stale: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return { value: cached, hit: true, stale: false };

    const existing = this.inflight.get(key);
    if (existing) return { value: (await existing) as T, hit: true, stale: false };

    const promise = (async () => {
      try {
        const value = await loader();
        await this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);

    try {
      const value = (await promise) as T;
      return { value, hit: false, stale: false };
    } catch (err) {
      if (opts.staleOnError && this.lastKnown.has(key)) {
        return { value: this.lastKnown.get(key) as T, hit: false, stale: true };
      }
      throw err;
    }
  }
}
