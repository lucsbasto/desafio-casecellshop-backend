import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ERP_PORT } from '../../src/application/ports/erp.port';
import { ORDER_REPO_PORT, OrderRepositoryPort } from '../../src/application/ports/repository.port';
import { ReconcileUseCase } from '../../src/application/use-cases/reconcile.usecase';
import { createPendingOrder, Order } from '../../src/domain/order';
import { bootE2E } from '../support/harness';
import {
  getMetrics,
  metricValue,
  postCheckout,
  productStock,
  settleOrder,
} from '../support/helpers';

/**
 * TC-RESIL — Resiliência assíncrona (fila/worker/ERP). P0: enfileiramento,
 * conclusão, retry em falha transitória, FAILED ao esgotar tentativas e
 * reconciliação (estoque liberado em falha definitiva).
 */
describe('TC-RESIL — Resiliência (e2e)', () => {
  it('TC-RESIL-01 — pedido é criado e enfileirado ao aceitar', async () => {
    const e = await bootE2E({ env: { ERP_MIN_LATENCY_MS: '500', ERP_MAX_LATENCY_MS: '500' } });
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-01',
      ).expect(202);
      // Há 1 pedido correspondente ao job aceito (não é pedido fantasma).
      const status = await request(e.http)
        .get(`/orders/${created.body.orderId}/status`)
        .expect(200);
      expect(status.body.id).toBe(created.body.orderId);
      await e.queue.drain();
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-02 — worker processa e conclui (CONFIRMED)', async () => {
    const e = await bootE2E({ env: { ERP_FAIL_RATE: '0' } });
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-02',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED');
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'worker_jobs_total', { result: 'confirmed' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-03 — retry em falha transitória conclui após nova tentativa', async () => {
    let attempts = 0;
    const flakyErp = {
      async invoice(order: Order): Promise<{ erpInvoiceId: string }> {
        attempts++;
        if (attempts === 1) throw new Error('falha transitória do ERP');
        return { erpInvoiceId: `ERP-${order.id.slice(0, 6)}` };
      },
    };
    const e = await bootE2E({
      env: { WORKER_MAX_ATTEMPTS: '3', WORKER_BACKOFF_MS: '0' },
      customize: (b) => b.overrideProvider(ERP_PORT).useValue(flakyErp),
    });
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-03',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED');
      expect(attempts).toBeGreaterThanOrEqual(2);
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'worker_jobs_total', { result: 'retried' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-04 — esgotar retries leva a FAILED com motivo', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '2', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-04',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('FAILED');
      const last = final.history[final.history.length - 1] as { status: string; reason?: string };
      expect(last.reason).toBeTruthy();
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'worker_jobs_total', { result: 'failed' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-06 — reconciliação: estoque liberado em falha definitiva', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '2', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const before = await productStock(e.http, 'CAPA-002');
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-002', quantity: 1 }] },
        'resil-06',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('FAILED');
      expect(await productStock(e.http, 'CAPA-002')).toBe(before); // reserva devolvida
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-05 — backoff entre tentativas é aplicado', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '3', WORKER_BACKOFF_MS: '120' },
    });
    try {
      const start = Date.now();
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-05',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      const elapsed = Date.now() - start;
      expect(final.status).toBe('FAILED');
      // Com backoff de 120ms entre tentativas, o tempo total reflete a espera
      // (vs. ~0 sem backoff). Limite inferior conservador.
      expect(elapsed).toBeGreaterThanOrEqual(120);
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-07 — latência alta do ERP é tolerada sem derrubar a API', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '0', ERP_MIN_LATENCY_MS: '400', ERP_MAX_LATENCY_MS: '400' },
    });
    try {
      const start = Date.now();
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-07',
      ).expect(202);
      expect(Date.now() - start).toBeLessThan(250); // 202 não espera o ERP lento
      await request(e.http).get('/products').expect(200); // API segue no ar
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED'); // worker absorve a latência
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-08 — reentrega do mesmo job não fatura 2× (worker idempotente)', async () => {
    const e = await bootE2E({ env: { ERP_FAIL_RATE: '0' } });
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'resil-08',
      ).expect(202);
      const orderId = created.body.orderId;
      expect((await settleOrder(e.http, e.queue, orderId)).status).toBe('CONFIRMED');

      const erpBefore = metricValue(await getMetrics(e.http), 'erp_calls_total', {
        result: 'success',
      });
      await e.queue.enqueue({ orderId, correlationId: 'resil-08-redelivery' }); // duplicata
      await e.queue.drain();
      const erpAfter = metricValue(await getMetrics(e.http), 'erp_calls_total', {
        result: 'success',
      });

      expect(erpAfter).toBe(erpBefore); // worker ignorou o pedido já terminal
      const status = await request(e.http).get(`/orders/${orderId}/status`).expect(200);
      expect(status.body.status).toBe('CONFIRMED');
    } finally {
      await e.close();
    }
  });

  it('TC-RESIL-09 — reconciliação processa pedido PENDING órfão (sem job)', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '0', RECONCILE_AGE_MS: '0', RECONCILE_MAX_AGE_MS: '600000' },
    });
    try {
      // Pedido PENDING "órfão": persistido mas NUNCA enfileirado (simula crash entre
      // gravar o pedido e publicar na fila).
      const repo = e.app.get<OrderRepositoryPort>(ORDER_REPO_PORT);
      const orderId = randomUUID();
      await repo.save(
        createPendingOrder({
          id: orderId,
          items: [{ productId: 'CAPA-001', quantity: 1 }],
          idempotencyKey: `orphan-${orderId}`,
          totalCents: 4990,
          now: new Date(Date.now() - 1000).toISOString(),
        }),
      );

      const before = await request(e.http).get(`/orders/${orderId}/status`).expect(200);
      expect(before.body.status).toBe('PENDING'); // preso, sem processamento

      const report = await e.app.get(ReconcileUseCase).execute();
      expect(report.requeued).toBeGreaterThanOrEqual(1); // rede de segurança reenfileira

      const final = await settleOrder(e.http, e.queue, orderId);
      expect(final.status).toBe('CONFIRMED'); // saiu do limbo e concluiu
    } finally {
      await e.close();
    }
  });
});
