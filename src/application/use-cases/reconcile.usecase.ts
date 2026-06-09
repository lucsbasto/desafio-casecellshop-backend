import { Inject, Injectable, Logger } from '@nestjs/common';
import { QUEUE_PORT, QueuePort } from '../ports/queue.port';
import {
  ORDER_REPO_PORT,
  OrderRepositoryPort,
} from '../ports/repository.port';
import { STOCK_PORT, StockPort } from '../ports/stock.port';
import { OrderStatus, transition } from '../../domain/order';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';
import { MetricsService } from '../../observability/metrics.service';

export interface ReconcileReport {
  requeued: number;
  failed: number;
  scanned: number;
}

/**
 * Reconciliação simples (anti pedido-fantasma): varre pedidos PENDING órfãos.
 * - Mais velhos que RECONCILE_AGE_MS: reenfileira (o enqueue pode ter falhado).
 * - Mais velhos que RECONCILE_MAX_AGE_MS: marca FAILED e compensa o estoque.
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
        // Velho demais: falha definitiva + compensação.
        const failedOrder = transition(
          order,
          OrderStatus.FAILED,
          now.toISOString(),
          'reconciliação: PENDING órfão expirado',
        );
        await this.orders.save(failedOrder);
        for (const item of order.items) {
          await this.stock.release(item.productId, item.quantity);
        }
        failed++;
      } else {
        // Reenfileira: o job pode ter se perdido entre gravar e enfileirar.
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
