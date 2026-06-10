import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DuplicateRequestError,
  InsufficientStockError,
  ProductNotFoundError,
} from '../../domain/errors';
import { Order, OrderItem, OrderStatus } from '../../domain/order';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';
import { setOrderId } from '../../observability/correlation';
import { MetricsService } from '../../observability/metrics.service';
import { TracingService } from '../../observability/tracing.service';
import { IDEMPOTENCY_PORT, IdempotencyPort } from '../ports/idempotency.port';
import { QUEUE_PORT, QueuePort } from '../ports/queue.port';
import {
  ORDER_REPO_PORT,
  OrderRepositoryPort,
  PRODUCT_REPO_PORT,
  ProductRepositoryPort,
} from '../ports/repository.port';
import { STOCK_PORT, StockPort } from '../ports/stock.port';

export interface CheckoutInput {
  items: OrderItem[];
  idempotencyKey?: string;
  correlationId: string;
}

export interface CheckoutOutput {
  order: Order;
  replay: boolean;
}

/**
 * Initiates the async checkout. Order (anti ghost-order/message, design D7):
 *   idempotency -> atomic reservation -> save PENDING -> enqueue -> 202.
 */
@Injectable()
export class CheckoutUseCase {
  private readonly logger = new Logger(CheckoutUseCase.name);

  constructor(
    @Inject(STOCK_PORT) private readonly stock: StockPort,
    @Inject(IDEMPOTENCY_PORT) private readonly idempotency: IdempotencyPort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(ORDER_REPO_PORT) private readonly orders: OrderRepositoryPort,
    @Inject(PRODUCT_REPO_PORT) private readonly products: ProductRepositoryPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
    private readonly tracing: TracingService,
  ) {}

  async execute(input: CheckoutInput): Promise<CheckoutOutput> {
    const endTimer = this.metrics.checkoutDuration.startTimer();
    try {
      const result = await this.run(input);
      this.metrics.checkoutRequests.inc({
        outcome: result.replay ? 'replay' : 'accepted',
      });
      return result;
    } catch (err) {
      const code = (err as { code?: string }).code;
      this.metrics.checkoutRequests.inc({
        outcome: code === 'INSUFFICIENT_STOCK' ? 'conflict' : 'invalid',
      });
      throw err;
    } finally {
      endTimer();
    }
  }

  private async run(input: CheckoutInput): Promise<CheckoutOutput> {
    const key = input.idempotencyKey ?? randomUUID();
    if (!input.idempotencyKey) {
      this.logger.warn(
        'POST /checkout sem Idempotency-Key; gerando uma. Recomenda-se o cliente enviar a chave.',
      );
    }

    const orderId = randomUUID();
    setOrderId(orderId);

    // 1) Idempotency: claims the key atomically.
    const rec = await this.idempotency.remember(key, orderId, this.config.idempotencyTtlMs);
    if (!rec.created) {
      const existing = await this.orders.findById(rec.orderId);
      if (existing) {
        setOrderId(existing.id);
        return { order: existing, replay: true };
      }
      // Key claimed by an attempt that did not persist the order.
      throw new DuplicateRequestError();
    }

    // 2) Validates products / prices and atomically reserves stock.
    const reserved: OrderItem[] = [];
    let totalCents = 0;
    try {
      for (const item of input.items) {
        const product = await this.products.findById(item.productId);
        if (!product) throw new ProductNotFoundError(item.productId);

        const outcome = await this.tracing.withSpan('stock.reserve', () =>
          this.stock.reserve(item.productId, item.quantity),
        );
        if (!outcome.ok) {
          this.metrics.stockReservation.inc({ result: 'insufficient' });
          this.metrics.oversellPrevented.inc();
          throw new InsufficientStockError(item.productId);
        }
        this.metrics.stockReservation.inc({ result: 'ok' });
        reserved.push(item);
        totalCents += product.priceCents * item.quantity;
      }
    } catch (err) {
      // Compensation: releases what was already reserved in this attempt.
      for (const r of reserved) {
        await this.stock.release(r.productId, r.quantity);
      }
      throw err;
    }

    // 3) Saves the PENDING order (source of truth) BEFORE enqueueing.
    const now = new Date().toISOString();
    const order: Order = {
      id: orderId,
      items: input.items,
      status: OrderStatus.PENDING,
      history: [{ status: OrderStatus.PENDING, at: now }],
      idempotencyKey: key,
      totalCents,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    await this.orders.save(order);

    // 4) Enqueues (logical outbox). If this fails, reconciliation will re-enqueue.
    await this.tracing.withSpan('queue.enqueue', () =>
      this.queue.enqueue({ orderId: order.id, correlationId: input.correlationId }),
    );
    this.metrics.queueDepth.set(await this.queue.depth());

    this.logger.log(`Pedido ${order.id} criado (PENDING) e enfileirado`);
    return { order, replay: false };
  }
}
