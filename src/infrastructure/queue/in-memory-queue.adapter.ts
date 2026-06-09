import { CheckoutJob, QueuePort, QueueProcessor } from '../../application/ports/queue.port';

export interface InMemoryQueueOptions {
  maxAttempts: number;
  backoffMs: number;
  /** In tests, use 0 to make the backoff deterministic/instant. */
  backoffFactor?: number;
}

interface QueuedJob {
  job: CheckoutJob;
  attempt: number;
}

/**
 * In-memory queue with retry + exponential backoff, mirroring BullMQ behavior.
 * Tracks the count of in-flight jobs for the queue_depth metric and invokes
 * `onExhausted` (compensation/DLQ) when all attempts are exhausted.
 *
 * `drain()` lets tests wait for full processing in a deterministic way
 * (without fragile sleeps).
 */
export class InMemoryQueueAdapter implements QueuePort {
  private processor?: QueueProcessor;
  private pending = 0;
  private readonly settled: Array<Promise<void>> = [];

  constructor(private readonly opts: InMemoryQueueOptions) {}

  register(processor: QueueProcessor): void {
    this.processor = processor;
  }

  async enqueue(job: CheckoutJob): Promise<void> {
    this.pending++;
    const p = this.run({ job, attempt: 1 }).finally(() => this.pending--);
    this.settled.push(p);
  }

  private async run(queued: QueuedJob): Promise<void> {
    if (!this.processor) throw new Error('Nenhum processador registrado na fila');
    try {
      await this.processor.process(queued.job, queued.attempt);
    } catch (err) {
      const error = err as Error;
      if (queued.attempt < this.opts.maxAttempts) {
        const factor = this.opts.backoffFactor ?? 2;
        const delay = this.opts.backoffMs * factor ** (queued.attempt - 1);
        await this.sleep(delay);
        await this.run({ job: queued.job, attempt: queued.attempt + 1 });
      } else {
        // Attempts exhausted: compensation / dead-letter.
        await this.processor.onExhausted(queued.job, error);
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
    await Promise.allSettled([...this.settled]);
  }

  async close(): Promise<void> {
    await this.drain();
  }
}
