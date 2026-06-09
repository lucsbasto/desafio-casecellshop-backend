import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isTerminal, Order, OrderStatus, transition } from '../../domain/order';
import { runWithCorrelation } from '../../observability/correlation';
import { MetricsService } from '../../observability/metrics.service';
import { TracingService } from '../../observability/tracing.service';
import { ERP_PORT, ErpPort } from '../ports/erp.port';
import { CheckoutJob, QUEUE_PORT, QueuePort, QueueProcessor } from '../ports/queue.port';
import { ORDER_REPO_PORT, OrderRepositoryPort } from '../ports/repository.port';
import { STOCK_PORT, StockPort } from '../ports/stock.port';

/**
 * Async checkout worker. Idempotent: ignores already-terminal or non-existent orders.
 * On success confirms; when attempts are exhausted, marks FAILED and
 * compensates (releases the stock reservation).
 */
@Injectable()
export class CheckoutWorker implements QueueProcessor, OnModuleInit {
  private readonly logger = new Logger(CheckoutWorker.name);

  constructor(
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(ERP_PORT) private readonly erp: ErpPort,
    @Inject(ORDER_REPO_PORT) private readonly orders: OrderRepositoryPort,
    @Inject(STOCK_PORT) private readonly stock: StockPort,
    private readonly metrics: MetricsService,
    private readonly tracing: TracingService,
  ) {}

  onModuleInit(): void {
    this.queue.register(this);
  }

  async process(job: CheckoutJob, attempt: number): Promise<void> {
    await runWithCorrelation(
      { correlationId: job.correlationId, orderId: job.orderId },
      async () => {
        const endTimer = this.metrics.workerDuration.startTimer();
        try {
          await this.tracing.withSpan('worker.process', () => this.handle(job, attempt), {
            orderId: job.orderId,
            attempt,
          });
        } finally {
          endTimer();
          this.metrics.queueDepth.set(await this.queue.depth());
        }
      },
    );
  }

  private async handle(job: CheckoutJob, attempt: number): Promise<void> {
    const order = await this.orders.findById(job.orderId);
    if (!order) {
      this.logger.warn(`Job para pedido inexistente ${job.orderId}; ignorando`);
      return;
    }
    if (isTerminal(order.status)) {
      this.logger.log(`Pedido ${order.id} já está ${order.status}; job idempotente, ignorado`);
      return;
    }
    // A concurrent worker (BullMQ concurrency / duplicate delivery) may already be
    // invoicing this order. PROCESSING is not terminal, so guard it explicitly to
    // avoid a double ERP invoice. A retry of THIS attempt re-reads PENDING and proceeds.
    if (order.status === OrderStatus.PROCESSING && attempt === order.attempts) {
      this.logger.warn(
        `Pedido ${order.id} já em PROCESSING (attempt ${attempt}); job duplicado ignorado`,
      );
      return;
    }

    const processing = transition(
      { ...order, attempts: attempt },
      OrderStatus.PROCESSING,
      new Date().toISOString(),
      `tentativa ${attempt}`,
    );
    await this.orders.save(processing);

    try {
      const { erpInvoiceId } = await this.invoiceWithMetrics(processing);
      const confirmed = transition(
        processing,
        OrderStatus.CONFIRMED,
        new Date().toISOString(),
        `ERP invoice ${erpInvoiceId}`,
      );
      await this.orders.save(confirmed);
      this.metrics.workerJobs.inc({ result: 'confirmed' });
      this.logger.log(`Pedido ${order.id} CONFIRMED (invoice ${erpInvoiceId})`);
    } catch (err) {
      this.metrics.workerJobs.inc({ result: 'retried' });
      this.logger.warn(
        `Falha ao faturar pedido ${order.id} (tentativa ${attempt}): ${(err as Error).message}`,
      );
      throw err; // lets the queue reprocess (retry/backoff)
    }
  }

  /** Called by the queue when attempts are exhausted: FAILED + compensation. */
  async onExhausted(job: CheckoutJob, error: Error): Promise<void> {
    await runWithCorrelation(
      { correlationId: job.correlationId, orderId: job.orderId },
      async () => {
        const order = await this.orders.findById(job.orderId);
        if (!order || isTerminal(order.status)) return;

        const failed = transition(
          order,
          OrderStatus.FAILED,
          new Date().toISOString(),
          `esgotadas as tentativas: ${error.message}`,
        );
        await this.orders.save(failed);

        // Compensation: returns the reserved stock (releases run concurrently).
        await Promise.all(
          order.items.map((item) => this.stock.release(item.productId, item.quantity)),
        );
        this.metrics.workerJobs.inc({ result: 'failed' });
        this.logger.error(`Pedido ${order.id} FAILED após esgotar tentativas; estoque compensado`);
      },
    );
  }

  private async invoiceWithMetrics(order: Order): Promise<{ erpInvoiceId: string }> {
    const endTimer = this.metrics.erpDuration.startTimer();
    try {
      const res = await this.tracing.withSpan('erp.invoice', () => this.erp.invoice(order));
      this.metrics.erpCalls.inc({ result: 'success' });
      return res;
    } catch (err) {
      this.metrics.erpCalls.inc({ result: 'error' });
      throw err;
    } finally {
      endTimer();
    }
  }
}
