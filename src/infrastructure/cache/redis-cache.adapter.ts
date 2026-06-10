import type { Redis } from 'ioredis';
import { AbstractCacheAdapter } from './abstract-cache.adapter';
import { CacheJitterOptions } from './cache-jitter';

/**
 * Redis cache (cache-aside). Inherits in-process single-flight, stale-while-error
 * fallback and proportional TTL jitter from {@link AbstractCacheAdapter}; here it
 * only owns the Redis-backed storage (JSON serialize + corrupted-value eviction).
 * For cross-instance coordination a short SET NX lock would be used (see README).
 */
export class RedisCacheAdapter extends AbstractCacheAdapter {
  constructor(
    private readonly redis: Redis,
    options: CacheJitterOptions = {},
  ) {
    super(options);
  }

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

  protected async writeStore<T>(key: string, value: T, jitteredTtlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'PX', jitteredTtlMs);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
