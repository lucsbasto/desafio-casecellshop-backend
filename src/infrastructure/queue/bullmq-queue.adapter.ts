import { Queue, Worker, Job, QueueEvents, ConnectionOptions } from 'bullmq';
import {
  CheckoutJob,
  QueuePort,
  QueueProcessor,
} from '../../application/ports/queue.port';

const QUEUE_NAME = 'checkout';

export interface BullMqOptions {
  maxAttempts: number;
  backoffMs: number;
}

/** Converte a REDIS_URL em opções de conexão do BullMQ (gestão própria de conexão). */
function toConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    // Requisito do BullMQ para a conexão bloqueante do worker.
    maxRetriesPerRequest: null,
  };
}

/**
 * Fila BullMQ (Redis). Retry/backoff/DLQ nativos:
 * - `attempts` + `backoff` configuram o retry exponencial.
 * - jobs que esgotam tentativas disparam o evento 'failed' com attemptsMade
 *   final => chamamos `onExhausted` (compensação). BullMQ mantém o job em
 *   'failed' (atua como DLQ inspecionável).
 *
 * Recebe a URL (não a instância ioredis) para que o BullMQ use sua própria
 * conexão e evitar conflito de versões de ioredis aninhado.
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
      removeOnFail: false, // mantém para inspeção (DLQ lógica)
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
      // Só compensa quando as tentativas se esgotaram de fato.
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
