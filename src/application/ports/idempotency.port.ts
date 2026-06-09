export const IDEMPOTENCY_PORT = Symbol('IDEMPOTENCY_PORT');

export interface IdempotencyRecord {
  orderId: string;
  /** true if this caller created the record now; false if it already existed (replay). */
  created: boolean;
}

/**
 * Idempotency port. Ensures that the same Idempotency-Key produces a single
 * resource (orderId), tolerating retries and double-clicks.
 */
export interface IdempotencyPort {
  /**
   * Atomic key reservation:
   * - if the key is new, persists `orderId` and returns { created: true }.
   * - if it already exists, returns the existing orderId and { created: false } (replay).
   * Implementation: Redis SET NX EX / Map with lock.
   */
  remember(key: string, orderId: string, ttlMs: number): Promise<IdempotencyRecord>;
}
