export const CACHE_PORT = Symbol('CACHE_PORT');

/**
 * Cache port (cache-aside). The implementation must protect against
 * cache stampede (single-flight) in the getOrLoad method.
 */
export interface CachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;

  /**
   * Returns from cache if present (hit); otherwise executes `loader` (miss),
   * stores with TTL and returns. Concurrent callers on the same key share ONE single
   * loader execution (single-flight) — prevents stampede.
   * `staleOnError`: if true and the loader fails, serves the last stale value (fallback).
   */
  getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts?: { staleOnError?: boolean },
  ): Promise<{ value: T; hit: boolean; stale: boolean }>;
}
