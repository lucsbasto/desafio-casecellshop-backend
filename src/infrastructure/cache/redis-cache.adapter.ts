import type { Redis } from 'ioredis';
import { CachePort } from '../../application/ports/cache.port';

/**
 * Cache Redis (cache-aside). Single-flight em processo + jitter de TTL mitigam
 * stampede; para coordenação cross-instância usaria um lock SET NX curto (citado
 * no README). Mantém último valor para fallback stale-while-error.
 */
export class RedisCacheAdapter implements CachePort {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly lastKnown = new Map<string, unknown>();

  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
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
