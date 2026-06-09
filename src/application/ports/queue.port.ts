export const QUEUE_PORT = Symbol('QUEUE_PORT');

export interface CheckoutJob {
  orderId: string;
  /** Propagates the correlationId from the original request to the worker (traceability). */
  correlationId: string;
}

/**
 * Job processor. Maps directly to BullMQ:
 * - `process` = processor function (throwing an error => retry with backoff).
 * - `onExhausted` = 'failed' event when attempts are exhausted (compensation/DLQ).
 */
export interface QueueProcessor {
  process(job: CheckoutJob, attempt: number): Promise<void>;
  onExhausted(job: CheckoutJob, error: Error): Promise<void>;
}

/**
 * Queue port for async checkout. The queue acts as a "logical outbox":
 * the order is saved (PENDING) before enqueueing.
 * - redis: BullMQ (native retry/backoff/DLQ).
 * - memory: in-process queue with equivalent retry/backoff.
 */
export interface QueuePort {
  enqueue(job: CheckoutJob): Promise<void>;
  /** Registers the processor. Called once during worker bootstrap. */
  register(processor: QueueProcessor): void;
  /** Current queue depth (for the queue_depth metric). */
  depth(): Promise<number>;
  /** Graceful shutdown. */
  close(): Promise<void>;
}
