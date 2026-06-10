import request from 'supertest';
import { bootE2E } from '../support/harness';
import { getMetrics, metricValue, postCheckout, settleOrder } from '../support/helpers';

/**
 * TC-OBS — Observabilidade. P0: /metrics em formato Prometheus, métricas de
 * cache e de checkout/worker, e correlação fim-a-fim (correlationId/orderId).
 */
describe('TC-OBS — Observabilidade (e2e)', () => {
  it('TC-OBS-01 — endpoint /metrics disponível em formato Prometheus', async () => {
    const e = await bootE2E();
    try {
      const res = await request(e.http).get('/metrics').expect(200);
      expect(res.text).toContain('# HELP');
      expect(res.text).toContain('# TYPE');
    } finally {
      await e.close();
    }
  });

  it('TC-OBS-02 — métricas de cache hit/miss', async () => {
    const e = await bootE2E();
    try {
      await request(e.http).get('/products').expect(200); // miss
      await request(e.http).get('/products').expect(200); // hit
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'cache_requests_total', { result: 'miss' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        metricValue(metrics, 'cache_requests_total', { result: 'hit' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-OBS-03 — métricas de checkout/fila/worker', async () => {
    const e = await bootE2E();
    try {
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'obs-03',
      ).expect(202);
      await settleOrder(e.http, e.queue, created.body.orderId);
      const metrics = await getMetrics(e.http);
      expect(metrics).toContain('checkout_requests_total');
      expect(metrics).toContain('worker_jobs_total');
      expect(metrics).toContain('queue_depth');
      expect(
        metricValue(metrics, 'checkout_requests_total', { outcome: 'accepted' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-OBS-05 — correlationId propagado no header (gerado e ecoado)', async () => {
    const e = await bootE2E();
    try {
      // gerado pelo servidor
      const gen = await request(e.http).get('/products').expect(200);
      expect(gen.headers['x-correlation-id']).toBeTruthy();

      // ecoado quando fornecido pelo cliente
      const supplied = 'corr-fixed-123';
      const echo = await request(e.http)
        .get('/products')
        .set('x-correlation-id', supplied)
        .expect(200);
      expect(echo.headers['x-correlation-id']).toBe(supplied);
    } finally {
      await e.close();
    }
  });

  it('TC-OBS-06 — erro correlaciona corpo e header; pedido rastreável por orderId', async () => {
    const e = await bootE2E();
    try {
      const supplied = 'corr-err-456';
      const res = await request(e.http)
        .get('/orders/nao-existe/status')
        .set('x-correlation-id', supplied)
        .expect(404);
      expect(res.headers['x-correlation-id']).toBe(supplied);
      expect(res.body.correlationId).toBe(supplied);

      // orderId é a chave de rastreio fim-a-fim (checkout -> status).
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'obs-06',
      ).expect(202);
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED');
    } finally {
      await e.close();
    }
  });

  it('TC-OBS-04 — métricas do ERP (sucesso e erro) e histograma de latência', async () => {
    const ok = await bootE2E({ env: { ERP_FAIL_RATE: '0' } });
    try {
      const c = await postCheckout(
        ok.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'obs-04-ok',
      ).expect(202);
      await settleOrder(ok.http, ok.queue, c.body.orderId);
      const m = await getMetrics(ok.http);
      expect(metricValue(m, 'erp_calls_total', { result: 'success' })).toBeGreaterThanOrEqual(1);
      expect(m).toContain('erp_call_duration_seconds');
    } finally {
      await ok.close();
    }

    const fail = await bootE2E({
      env: { ERP_FAIL_RATE: '1', WORKER_MAX_ATTEMPTS: '2', WORKER_BACKOFF_MS: '0' },
    });
    try {
      const c = await postCheckout(
        fail.http,
        { items: [{ productId: 'CAPA-002', quantity: 1 }] },
        'obs-04-fail',
      ).expect(202);
      await settleOrder(fail.http, fail.queue, c.body.orderId);
      const m = await getMetrics(fail.http);
      expect(metricValue(m, 'erp_calls_total', { result: 'error' })).toBeGreaterThanOrEqual(1);
    } finally {
      await fail.close();
    }
  });

  it('TC-OBS-07 — correlação propaga request → worker (header ecoado + orderId rastreável)', async () => {
    const e = await bootE2E();
    try {
      const corr = 'corr-w-123';
      const created = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'obs-07',
      )
        .set('x-correlation-id', corr)
        .expect(202);
      expect(created.headers['x-correlation-id']).toBe(corr);
      // O worker roda com runWithCorrelation(job.correlationId): a identidade do
      // pedido (orderId) liga a requisição HTTP ao processamento assíncrono.
      const final = await settleOrder(e.http, e.queue, created.body.orderId);
      expect(final.status).toBe('CONFIRMED');
      const status = await request(e.http)
        .get(`/orders/${created.body.orderId}/status`)
        .expect(200);
      expect(status.body.id).toBe(created.body.orderId);
    } finally {
      await e.close();
    }
  });

  it('TC-OBS-09 — erros não vazam stacktrace nem caminhos internos ao cliente', async () => {
    const e = await bootE2E();
    try {
      const allowed = ['statusCode', 'error', 'message', 'correlationId', 'timestamp'].sort();
      const errors = [
        await request(e.http).get('/orders/inexistente/status').expect(404),
        await postCheckout(e.http, { items: [] }, 'obs-09-bad').expect(400),
        await postCheckout(
          e.http,
          { items: [{ productId: 'CAPA-004', quantity: 1 }] },
          'obs-09-409',
        ).expect(409),
      ];
      for (const res of errors) {
        expect(Object.keys(res.body).sort()).toEqual(allowed);
        expect(res.body).not.toHaveProperty('stack');
        expect(res.body).not.toHaveProperty('stacktrace');
        expect(String(res.body.message)).not.toMatch(/\.ts:|[\\/]src[\\/]/);
      }
    } finally {
      await e.close();
    }
  });

  it.todo('TC-OBS-08 — traces OTel→Jaeger: requer Docker/collector (Tier B)');
  it.todo(
    'TC-OBS-10 — runbook/dashboard/alertas: revisão de documentação (README + provisioning), não automatizável aqui',
  );
});
