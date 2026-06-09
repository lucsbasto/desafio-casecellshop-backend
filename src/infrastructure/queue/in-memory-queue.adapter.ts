import {
  CheckoutJob,
  QueuePort,
  QueueProcessor,
} from '../../application/ports/queue.port';

export interface InMemoryQueueOptions {
  maxAttempts: number;
  backoffMs: number;
  /** Em testes, usar 0 para tornar o backoff determinístico/instantâneo. */
  backoffFactor?: number;
}

interface QueuedJob {
  job: CheckoutJob;
  attempt: number;
}

/**
 * Fila in-memory com retry + backoff exponencial, espelhando o comportamento do
 * BullMQ. Mantém contagem de jobs em voo para a métrica queue_depth e invoca
 * `onExhausted` (compensação/DLQ) quando as tentativas se esgotam.
 *
 * `drain()` permite que os testes aguardem o processamento completo de forma
 * determinística (sem sleeps frágeis).
 */
export class InMemoryQueueAdapter implements QueuePort {
  private processor?: QueueProcessor;
  private inFlight = 0;
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
    this.inFlight++;
    try {
      await this.processor.process(queued.job, queued.attempt);
    } catch (err) {
      const error = err as Error;
      if (queued.attempt < this.opts.maxAttempts) {
        const factor = this.opts.backoffFactor ?? 2;
        const delay = this.opts.backoffMs * Math.pow(factor, queued.attempt - 1);
        await this.sleep(delay);
        await this.run({ job: queued.job, attempt: queued.attempt + 1 });
      } else {
        // Tentativas esgotadas: compensação / dead-letter.
        await this.processor.onExhausted(queued.job, error);
      }
    } finally {
      this.inFlight--;
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async depth(): Promise<number> {
    return this.pending;
  }

  /** Aguarda todos os jobs enfileirados terminarem (uso em testes). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.settled]);
  }

  async close(): Promise<void> {
    await this.drain();
  }
}
