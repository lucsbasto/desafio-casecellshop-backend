import { ConnectionOptions, Job, Queue, QueueEvents, Worker } from 'bullmq';
import { CheckoutJob, QueuePort, QueueProcessor } from '../../application/ports/queue.port';

const QUEUE_NAME = 'checkout';

export interface BullMqOptions {
  maxAttempts: number;
  backoffMs: number;
}

/** Converts REDIS_URL into BullMQ connection options (self-managed connection). */
function toConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    // Required by BullMQ for the worker's blocking connection.
    maxRetriesPerRequest: null,
  };
}

/**
 * BullMQ queue (Redis). Native retry/backoff/DLQ:
 * - `attempts` + `backoff` configure exponential retry.
 * - Jobs that exhaust all attempts fire the 'failed' event with the final
 *   attemptsMade => we call `onExhausted` (compensation). BullMQ keeps the job
 *   in 'failed' state (acts as an inspectable DLQ).
 *
 * Accepts the URL (not the ioredis instance) so that BullMQ uses its own
 * connection and avoids nested ioredis version conflicts.
 */
export class BullMqQueueAdapter implements QueuePort {
  private readonly connection: ConnectionOptions;
  private readonly queue: Queue;
  private readonly events: QueueEvents;
  private worker?: Worker;

  constructor(
    redisUrl: string,
    private readonly opts: BullMqOptions,
  ) {
    this.connection = toConnection(redisUrl);
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    this.events = new QueueEvents(QUEUE_NAME, { connection: this.connection });
  }

  async enqueue(job: CheckoutJob): Promise<void> {
    await this.queue.add('process-checkout', job, {
      attempts: this.opts.maxAttempts,
      backoff: { type: 'exponential', delay: this.opts.backoffMs },
      removeOnComplete: 1000,
      removeOnFail: false, // keep for inspection (logical DLQ)
    });
  }

  register(processor: QueueProcessor): void {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<CheckoutJob>) => {
        await processor.process(job.data, job.attemptsMade + 1);
      },
      { connection: this.connection, concurrency: 4 },
    );

    this.worker.on('failed', (job: Job<CheckoutJob> | undefined, err: Error) => {
      if (!job) return;
      // Only compensate when attempts have actually been exhausted.
      if (job.attemptsMade >= this.opts.maxAttempts) {
        void processor.onExhausted(job.data, err);
      }
    });
  }

  async depth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.events.close();
    await this.queue.close();
  }
}
