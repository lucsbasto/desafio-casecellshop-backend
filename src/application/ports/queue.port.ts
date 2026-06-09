export const QUEUE_PORT = Symbol('QUEUE_PORT');

export interface CheckoutJob {
  orderId: string;
  /** Propaga o correlationId do request original para o worker (rastreabilidade). */
  correlationId: string;
}

/**
 * Processador de jobs. Mapeia diretamente para o BullMQ:
 * - `process` = função processadora (lançar erro => retry com backoff).
 * - `onExhausted` = evento 'failed' quando as tentativas se esgotam (compensação/DLQ).
 */
export interface QueueProcessor {
  process(job: CheckoutJob, attempt: number): Promise<void>;
  onExhausted(job: CheckoutJob, error: Error): Promise<void>;
}

/**
 * Porta de fila para o checkout assíncrono. A fila funciona como "outbox lógico":
 * o pedido é gravado (PENDING) antes de enfileirar.
 * - redis: BullMQ (retry/backoff/DLQ nativos).
 * - memory: fila em processo com retry/backoff equivalente.
 */
export interface QueuePort {
  enqueue(job: CheckoutJob): Promise<void>;
  /** Registra o processador. Chamado uma vez no bootstrap do worker. */
  register(processor: QueueProcessor): void;
  /** Profundidade atual da fila (para a métrica queue_depth). */
  depth(): Promise<number>;
  /** Encerramento gracioso. */
  close(): Promise<void>;
}
