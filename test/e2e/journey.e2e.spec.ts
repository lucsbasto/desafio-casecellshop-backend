import request from 'supertest';
import { bootE2E } from '../support/harness';
import {
  getMetrics,
  metricValue,
  postCheckout,
  productStock,
  settleOrder,
} from '../support/helpers';

/**
 * TC-E2E — Jornadas fim-a-fim. P0: caminho feliz completo, jornada de falha com
 * reconciliação e pico concorrente sem overselling.
 */
describe('TC-E2E — Jornadas fim-a-fim (e2e)', () => {
  it('TC-E2E-01 — jornada feliz completa', async () => {
    const e = await bootE2E({ env: { PRODUCTS_CACHE_TTL_MS: '120' } });
    try {
      // 1) miss -> hit
      await request(e.http).get('/products').expect(200);
      await request(e.http).get('/products').expect(200);
      const before = await productStock(e.http, 'CAPA-001');

      // 2) checkout
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'e2e-01',
      ).expect(202);

      // 3) polling até terminal
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED');

      // 4) vitrine após TTL reflete o decremento
      await new Promise((r) => setTimeout(r, 200));
      expect(await productStock(e.http, 'CAPA-001')).toBe(before - 1);

      // 5) métricas coerentes
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'cache_requests_total', { result: 'hit' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        metricValue(metrics, 'worker_jobs_total', { result: 'confirmed' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-E2E-02 — jornada de falha com reconciliação', async () => {
    const e = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '2', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const before = await productStock(e.http, 'CAPA-002');
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-002', quantity: 1 }] },
        'e2e-02',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('FAILED');
      expect(await productStock(e.http, 'CAPA-002')).toBe(before); // estoque devolvido
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'worker_jobs_total', { result: 'failed' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-E2E-03 — pico concorrente sem overselling e sem 5xx', async () => {
    const e = await bootE2E(); // CAPA-003 = 5
    try {
      const checkouts = Array.from({ length: 50 }, (_, i) =>
        postCheckout(e.http, { items: [{ productId: 'CAPA-003', quantity: 1 }] }, `e2e-03-${i}`),
      );
      const reads = Array.from({ length: 50 }, () => request(e.http).get('/products'));
      const [coRes, rdRes] = await Promise.all([Promise.all(checkouts), Promise.all(reads)]);

      const accepted = coRes.filter((r) => r.status === 202).length;
      const server5xx = [...coRes, ...rdRes].filter((r) => r.status >= 500).length;
      expect(accepted).toBeLessThanOrEqual(5);
      expect(accepted).toBe(5);
      expect(server5xx).toBe(0);
      for (const r of rdRes) expect(r.status).toBe(200);

      await e.queue.drain();
      expect(await productStock(e.http, 'CAPA-003')).toBe(0);
    } finally {
      await e.close();
    }
  });
});
