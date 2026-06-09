import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderStatus, transition } from '../../domain/order';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';
import { MetricsService } from '../../observability/metrics.service';
import { QUEUE_PORT, QueuePort } from '../ports/queue.port';
import { ORDER_REPO_PORT, OrderRepositoryPort } from '../ports/repository.port';
import { STOCK_PORT, StockPort } from '../ports/stock.port';

export interface ReconcileReport {
  requeued: number;
  failed: number;
  scanned: number;
}

/**
 * Simple reconciliation (anti ghost-order): scans orphan PENDING orders.
 * - Older than RECONCILE_AGE_MS: re-enqueues (the enqueue may have failed).
 * - Older than RECONCILE_MAX_AGE_MS: marks FAILED and compensates stock.
 */
@Injectable()
export class ReconcileUseCase {
  private readonly logger = new Logger(ReconcileUseCase.name);

  constructor(
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(ORDER_REPO_PORT) private readonly orders: OrderRepositoryPort,
    @Inject(STOCK_PORT) private readonly stock: StockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  async execute(now = new Date()): Promise<ReconcileReport> {
    const ageCutoff = new Date(now.getTime() - this.config.reconcile.ageMs);
    const maxAgeCutoff = new Date(now.getTime() - this.config.reconcile.maxAgeMs);

    const candidates = await this.orders.findPendingOlderThan(ageCutoff);
    let requeued = 0;
    let failed = 0;

    for (const order of candidates) {
      const createdAt = new Date(order.createdAt);
      if (createdAt < maxAgeCutoff) {
        // Too old: definitive failure + compensation.
        const failedOrder = transition(
          order,
          OrderStatus.FAILED,
          now.toISOString(),
          'reconciliação: PENDING órfão expirado',
        );
        await this.orders.save(failedOrder);
        await Promise.all(
          order.items.map((item) => this.stock.release(item.productId, item.quantity)),
        );
        failed++;
      } else {
        // Re-enqueues: the job may have been lost between saving and enqueueing.
        await this.queue.enqueue({
          orderId: order.id,
          correlationId: `reconcile-${order.id}`,
        });
        requeued++;
      }
    }

    if (requeued || failed) {
      this.logger.warn(
        `Reconciliação: ${requeued} reenfileirados, ${failed} falhados de ${candidates.length} candidatos`,
      );
    }
    this.metrics.queueDepth.set(await this.queue.depth());
    return { requeued, failed, scanned: candidates.length };
  }
}
