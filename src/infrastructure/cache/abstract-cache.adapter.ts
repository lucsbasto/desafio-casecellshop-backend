import { CachePort } from '../../application/ports/cache.port';
import { CacheJitterOptions, createJitter } from './cache-jitter';

/**
 * Template Method base for cache adapters. Owns the driver-INDEPENDENT algorithm:
 * single-flight (request coalescing via `inflight`) + stale-while-error fallback
 * (via `lastKnown`) + proportional TTL jitter. Subclasses provide only the
 * storage-specific primitives (`get`, `store`, `del`).
 *
 * `set` applies the jitter once and hands the already-jittered TTL to the subclass
 * `store`, so the Map adapter folds it into `expiresAt` and the Redis adapter passes
 * it as the PX value — behavior identical to the pre-refactor adapters.
 */
export abstract class AbstractCacheAdapter implements CachePort {
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Last known value (even if expired) for loader-error fallback. */
  private readonly lastKnown = new Map<string, unknown>();
  private readonly jitter: (ttlMs: number) => number;

  constructor(options: CacheJitterOptions = {}) {
    this.jitter = createJitter(options);
  }

  abstract get<T>(key: string): Promise<T | undefined>;

  abstract del(key: string): Promise<void>;

  /**
   * Persists `value` under `key` for `jitteredTtlMs` (the TTL already extended by
   * the shared jitter). Drivers decide how to encode it (Map expiresAt / Redis PX).
   */
  protected abstract writeStore<T>(key: string, value: T, jitteredTtlMs: number): Promise<void>;

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.writeStore(key, value, this.jitter(ttlMs));
    this.lastKnown.set(key, value);
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts: { staleOnError?: boolean } = {},
  ): Promise<{ value: T; hit: boolean; stale: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return { value: cached, hit: true, stale: false };
    }

    // Single-flight: if there is already an in-flight loader for this key, reuse it.
    const existing = this.inflight.get(key);
    if (existing) {
      const value = (await existing) as T;
      return { value, hit: true, stale: false };
    }

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
      // Fallback: serve the last good value (stale-while-error) if allowed.
      if (opts.staleOnError && this.lastKnown.has(key)) {
        return { value: this.lastKnown.get(key) as T, hit: false, stale: true };
      }
      throw err;
    }
  }
}
