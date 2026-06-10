/** Default proportional jitter window: up to +20% of the requested TTL. */
export const DEFAULT_JITTER_RATIO = 0.2;

export interface CacheJitterOptions {
  /**
   * Proportional TTL jitter window (0 disables, clamped to `[0, 1]`). Each `set`
   * extends the TTL by a random amount in `[0, ttlMs * jitterRatio]` (rounded to the
   * nearest ms), spreading expirations so that many keys written together don't expire
   * on the same tick and stampede the backend. Proportional (not a fixed offset) so it
   * scales with both short and long TTLs.
   */
  jitterRatio?: number;
  /** Randomness source, injectable for deterministic tests. Defaults to Math.random. */
  random?: () => number;
}

/**
 * Builds a jitter function shared by the cache adapters. It only ever EXTENDS the
 * TTL — a key never lives shorter than the caller requested — and floors the requested
 * TTL to 1ms so a zero/negative TTL still produces a valid expiry.
 */
export function createJitter(options: CacheJitterOptions = {}): (ttlMs: number) => number {
  const ratio = Math.min(1, Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO));
  const random = options.random ?? Math.random;
  return (ttlMs: number): number => {
    const base = Math.max(1, ttlMs);
    if (ratio === 0) return base;
    return base + Math.round(random() * base * ratio);
  };
}
