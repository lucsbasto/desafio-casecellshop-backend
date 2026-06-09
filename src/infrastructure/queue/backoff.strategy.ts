/**
 * Backoff policy (Strategy pattern: https://refactoring.guru/design-patterns/strategy).
 *
 * Extracts the retry-delay computation so the in-memory queue and the BullMQ
 * adapter share a single source of truth instead of duplicating the exponential
 * formula. `nextDelay(attempt)` returns the wait (ms) BEFORE the given attempt
 * number (1-based): attempt 1 has no preceding wait, attempt 2 waits baseMs, etc.
 */
export interface BackoffStrategy {
  /** Delay in ms to wait before retrying `attempt` (1-based). */
  nextDelay(attempt: number): number;
}

/** Exponential backoff with a hard ceiling: base * factor^(attempt-2), capped at maxMs. */
export class ExponentialBackoff implements BackoffStrategy {
  constructor(
    private readonly baseMs: number,
    private readonly factor = 2,
    private readonly maxMs = 30_000,
  ) {}

  nextDelay(attempt: number): number {
    if (attempt <= 1 || this.baseMs <= 0) return 0;
    const delay = this.baseMs * this.factor ** (attempt - 2);
    return Math.min(delay, this.maxMs);
  }
}
