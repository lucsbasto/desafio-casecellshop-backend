import { AbstractCacheAdapter } from './abstract-cache.adapter';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory cache with TTL. Inherits SINGLE-FLIGHT (request coalescing),
 * stale-while-error fallback and proportional TTL jitter from
 * {@link AbstractCacheAdapter}; here it only owns the Map-backed storage. The
 * jittered TTL is folded into `expiresAt` so behavior is driver-independent.
 */
export class InMemoryCacheAdapter extends AbstractCacheAdapter {
  private readonly store = new Map<string, Entry<unknown>>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  protected async writeStore<T>(key: string, value: T, jitteredTtlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + jitteredTtlMs });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}
