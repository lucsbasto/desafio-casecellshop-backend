import { CachePort } from '../../application/ports/cache.port';
import { CacheJitterOptions, createJitter } from './cache-jitter';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory cache with TTL and SINGLE-FLIGHT (request coalescing) to prevent
 * cache stampede: concurrent misses on the same key share a single loader
 * execution. Applies the same proportional TTL jitter as the Redis adapter so
 * behavior is driver-independent. Stores the last known value for stale-while-error fallback.
 */
export class InMemoryCacheAdapter implements CachePort {
  private readonly store = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Last known value (even if expired) for loader-error fallback. */
  private readonly lastKnown = new Map<string, unknown>();
  private readonly jitter: (ttlMs: number) => number;

  constructor(options: CacheJitterOptions = {}) {
    this.jitter = createJitter(options);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + this.jitter(ttlMs) });
    this.lastKnown.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
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
