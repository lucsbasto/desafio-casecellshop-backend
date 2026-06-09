import { CheckoutUseCase } from './checkout.usecase';
import { CheckoutWorker } from './checkout.worker';
import { GetOrderStatusUseCase } from './get-order-status.usecase';
import { OrderStatus } from '../../domain/order';
import { InsufficientStockError } from '../../domain/errors';
import { MetricsService } from '../../observability/metrics.service';
import { TracingService } from '../../observability/tracing.service';
import { AppConfig } from '../../infrastructure/config/app-config';
import { InMemoryStockAdapter } from '../../infrastructure/stock/in-memory-stock.adapter';
import { InMemoryIdempotencyAdapter } from '../../infrastructure/idempotency/in-memory-idempotency.adapter';
import { InMemoryQueueAdapter } from '../../infrastructure/queue/in-memory-queue.adapter';
import { InMemoryOrderRepository } from '../../infrastructure/repo/in-memory-order.repo';
import { InMemoryProductRepository } from '../../infrastructure/repo/in-memory-product.repo';
import { FakeErpClient } from '../../infrastructure/erp/fake-erp.client';
import { Product } from '../../domain/product';

const baseConfig = (over: Partial<AppConfig['worker']> = {}): AppConfig => ({
  port: 0,
  env: 'test',
  serviceName: 'test',
  logLevel: 'silent',
  drivers: { cache: 'memory', queue: 'memory', stock: 'memory', idempotency: 'memory' },
  redisUrl: '',
  cache: { productsTtlMs: 1000, stampedeJitterMs: 0 },
  worker: { maxAttempts: 3, backoffMs: 0, ...over },
  erp: { failRate: 0, minLatencyMs: 0, maxLatencyMs: 0 },
  reconcile: { ageMs: 10000, maxAgeMs: 60000 },
  idempotencyTtlMs: 60000,
});

async function buildHarness(opts: {
  seed: Product[];
  erpFailRate: number;
  maxAttempts?: number;
}) {
  const config = baseConfig({ maxAttempts: opts.maxAttempts ?? 3 });
  const metrics = new MetricsService();
  const tracing = new TracingService();
  const stock = new InMemoryStockAdapter();
  // Seeds stock from the catalog (equivalent to the module's StockSeeder).
  for (const p of opts.seed) await stock.init(p.id, p.stock);
  const idempotency = new InMemoryIdempotencyAdapter();
  const queue = new InMemoryQueueAdapter({ maxAttempts: config.worker.maxAttempts, backoffMs: 0 });
  const orders = new InMemoryOrderRepository();
  const products = new InMemoryProductRepository(opts.seed, 0);
  // fixed random: latency 0 and deterministic failure decision by erpFailRate.
  const erp = new FakeErpClient({
    failRate: opts.erpFailRate,
    minLatencyMs: 0,
    maxLatencyMs: 0,
    random: () => (opts.erpFailRate >= 1 ? 0 : 0.99),
  });

  const checkout = new CheckoutUseCase(
    stock, idempotency, queue, orders, products, config, metrics, tracing,
  );
  const worker = new CheckoutWorker(queue, erp, orders, stock, metrics, tracing);
  worker.onModuleInit(); // registra na fila
  const getStatus = new GetOrderStatusUseCase(orders);

  return { checkout, queue, getStatus, stock, metrics };
}

const SEED: Product[] = [
  { id: 'CAPA-001', name: 'Capa A', priceCents: 1000, stock: 2 },
];

describe('Fluxo de checkout assíncrono', () => {
  it('happy path: 202 PENDING -> worker -> CONFIRMED, estoque debitado', async () => {
    const h = await buildHarness({ seed: SEED, erpFailRate: 0 });
    const { order } = await h.checkout.execute({
      items: [{ productId: 'CAPA-001', quantity: 1 }],
      idempotencyKey: 'key-1',
      correlationId: 'c1',
    });
    expect(order.status).toBe(OrderStatus.PENDING);

    await h.queue.drain();
    const final = await h.getStatus.execute(order.id);
    expect(final.status).toBe(OrderStatus.CONFIRMED);
    expect(await h.stock.get('CAPA-001')).toBe(1);
  });

  it('idempotência: mesma Idempotency-Key => 1 pedido e 1 reserva', async () => {
    const h = await buildHarness({ seed: SEED, erpFailRate: 0 });
    const r1 = await h.checkout.execute({
      items: [{ productId: 'CAPA-001', quantity: 1 }],
      idempotencyKey: 'dup',
      correlationId: 'c1',
    });
    const r2 = await h.checkout.execute({
      items: [{ productId: 'CAPA-001', quantity: 1 }],
      idempotencyKey: 'dup',
      correlationId: 'c1',
    });

    expect(r2.replay).toBe(true);
    expect(r1.order.id).toBe(r2.order.id);
    expect(await h.stock.get('CAPA-001')).toBe(1); // debitou só uma vez
  });

  it('concorrência: 5 checkouts para estoque 2 => 2 aceitos, 3 sem estoque', async () => {
    const h = await buildHarness({ seed: SEED, erpFailRate: 0 });
    const attempts = Array.from({ length: 5 }, (_, i) =>
      h.checkout
        .execute({
          items: [{ productId: 'CAPA-001', quantity: 1 }],
          idempotencyKey: `k-${i}`,
          correlationId: `c-${i}`,
        })
        .then(() => 'ok')
        .catch((e) => (e instanceof InsufficientStockError ? 'no-stock' : 'err')),
    );
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'no-stock')).toHaveLength(3);
    expect(await h.stock.get('CAPA-001')).toBe(0);
  });

  it('resiliência: ERP sempre falha => FAILED após retries + estoque compensado', async () => {
    const h = await buildHarness({ seed: SEED, erpFailRate: 1, maxAttempts: 2 });
    const { order } = await h.checkout.execute({
      items: [{ productId: 'CAPA-001', quantity: 1 }],
      idempotencyKey: 'fail-1',
      correlationId: 'c1',
    });
    expect(await h.stock.get('CAPA-001')).toBe(1); // reservado

    await h.queue.drain();
    const final = await h.getStatus.execute(order.id);
    expect(final.status).toBe(OrderStatus.FAILED);
    expect(await h.stock.get('CAPA-001')).toBe(2); // compensado de volta
  });
});
