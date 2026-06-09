export const CACHE_PORT = Symbol('CACHE_PORT');

/**
 * Porta de cache (cache-aside). A implementação deve proteger contra
 * cache stampede (single-flight) no método getOrLoad.
 */
export interface CachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;

  /**
   * Retorna do cache se presente (hit); caso contrário executa `loader` (miss),
   * grava com TTL e retorna. Concorrentes na mesma chave compartilham UMA única
   * execução do loader (single-flight) — previne stampede.
   * `staleOnError`: se true e o loader falhar, serve o último valor stale (fallback).
   */
  getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    opts?: { staleOnError?: boolean },
  ): Promise<{ value: T; hit: boolean; stale: boolean }>;
}
