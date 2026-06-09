import { CachePort } from '../../application/ports/cache.port';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Cache in-memory com TTL e SINGLE-FLIGHT (request coalescing) para prevenir
 * cache stampede: misses concorrentes na mesma chave compartilham uma única
 * execução do loader. Guarda o último valor para fallback stale-while-error.
 */
export class InMemoryCacheAdapter implements CachePort {
  private readonly store = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Último valor conhecido (mesmo expirado) para fallback em erro do loader. */
  private readonly lastKnown = new Map<string, unknown>();

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
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
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

    // Single-flight: se já há um loader em voo para esta chave, reaproveita.
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
      // Fallback: serve o último valor bom (stale-while-error) se permitido.
      if (opts.staleOnError && this.lastKnown.has(key)) {
        return { value: this.lastKnown.get(key) as T, hit: false, stale: true };
      }
      throw err;
    }
  }
}
