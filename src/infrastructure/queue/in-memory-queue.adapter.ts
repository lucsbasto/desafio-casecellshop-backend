import { CheckoutJob, QueuePort, QueueProcessor } from '../../application/ports/queue.port';
import { BackoffStrategy, ExponentialBackoff } from './backoff.strategy';

export interface InMemoryQueueOptions {
  maxAttempts: number;
  backoffMs: number;
  /** In tests, use 0 to make the backoff deterministic/instant. */
  backoffFactor?: number;
  maxBackoffMs?: number;
}

/**
 * In-memory queue with retry + exponential backoff, mirroring BullMQ behavior
 * via a shared BackoffStrategy. Tracks in-flight jobs for the queue_depth metric
 * and invokes `onExhausted` (compensation/DLQ) when all attempts are exhausted.
 *
 * `drain()` lets tests wait for full processing deterministically (no sleeps).
 */
export class InMemoryQueueAdapter implements QueuePort {
  private processor?: QueueProcessor;
  private pending = 0;
  /** In-flight job promises; entries self-remove on settle to avoid unbounded growth. */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly backoff: BackoffStrategy;

  constructor(private readonly opts: InMemoryQueueOptions) {
    this.backoff = new ExponentialBackoff(
      opts.backoffMs,
      opts.backoffFactor ?? 2,
      opts.maxBackoffMs ?? 30_000,
    );
  }

  register(processor: QueueProcessor): void {
    this.processor = processor;
  }

  async enqueue(job: CheckoutJob): Promise<void> {
    this.pending++;
    const p = this.run(job)
      .finally(() => {
        this.pending--;
        this.inFlight.delete(p);
      })
      // Swallow here so an unexpected throw can't become an unhandled rejection;
      // run() already routes business failures to onExhausted.
      .catch(() => undefined);
    this.inFlight.add(p);
  }

  /** Iterative retry loop (no recursion, so deep retry counts can't blow the stack). */
  private async run(job: CheckoutJob): Promise<void> {
    if (!this.processor) throw new Error('Nenhum processador registrado na fila');
    let attempt = 1;
    while (true) {
      try {
        await this.processor.process(job, attempt);
        return;
      } catch (err) {
        if (attempt >= this.opts.maxAttempts) {
          // Attempts exhausted: compensation / dead-letter.
          await this.processor.onExhausted(job, err as Error);
          return;
        }
        await this.sleep(this.backoff.nextDelay(attempt + 1));
        attempt++;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async depth(): Promise<number> {
    return this.pending;
  }

  /** Waits for all enqueued jobs to finish (for use in tests). */
  async drain(): Promise<void> {
    // Loop because a job may enqueue follow-up work while we await the snapshot.
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async close(): Promise<void> {
    await this.drain();
  }
}
