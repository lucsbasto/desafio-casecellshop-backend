import request from 'supertest';
import { bootE2E } from '../support/harness';
import { getMetrics, metricValue, postCheckout, productStock } from '../support/helpers';

/**
 * TC-PROD — Catálogo de Produtos (GET /products). P0 do E2E-TEST-CASES.md.
 * Caixa-preta: valida vitrine, cache-aside (miss/hit/TTL) e anti-stale.
 */
describe('TC-PROD — Catálogo de Produtos (e2e)', () => {
  it('TC-PROD-01 — lista produtos com sucesso', async () => {
    const e = await bootE2E();
    try {
      const res = await request(e.http).get('/products').expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      for (const p of res.body) {
        expect(p).toHaveProperty('id');
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('priceCents');
        expect(p).toHaveProperty('stock');
      }
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-04 — primeira leitura é cache MISS', async () => {
    const e = await bootE2E();
    try {
      await request(e.http).get('/products').expect(200);
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'cache_requests_total', { result: 'miss' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-05 — segunda leitura é cache HIT com mesmo payload', async () => {
    const e = await bootE2E();
    try {
      const r1 = await request(e.http).get('/products').expect(200);
      const r2 = await request(e.http).get('/products').expect(200);
      expect(r2.body).toEqual(r1.body);
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'cache_requests_total', { result: 'hit' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-06 — expiração por TTL gera novo MISS', async () => {
    const e = await bootE2E({ env: { PRODUCTS_CACHE_TTL_MS: '120' } });
    try {
      await request(e.http).get('/products').expect(200); // miss -> popula
      await request(e.http).get('/products').expect(200); // hit
      const before = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      await new Promise((r) => setTimeout(r, 250)); // > TTL
      await request(e.http).get('/products').expect(200);
      const after = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      expect(after).toBeGreaterThan(before);
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-07 — vitrine reflete redução de estoque (anti-stale)', async () => {
    const e = await bootE2E({ env: { PRODUCTS_CACHE_TTL_MS: '120' } });
    try {
      const before = await productStock(e.http, 'CAPA-001');
      const r = await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-001', quantity: 1 }] },
        'prod-07',
      ).expect(202);
      await e.queue.drain();
      await new Promise((rs) => setTimeout(rs, 250)); // deixa o TTL expirar
      const after = await productStock(e.http, 'CAPA-001');
      expect(r.body.orderId).toBeDefined();
      expect(after).toBe(before - 1);
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-08 — disponibilidade nunca negativa', async () => {
    const e = await bootE2E();
    try {
      // CAPA-003 tem estoque 5: esgota com folga.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          postCheckout(e.http, { items: [{ productId: 'CAPA-003', quantity: 1 }] }, `prod-08-${i}`),
        ),
      );
      await e.queue.drain();
      const stock = await productStock(e.http, 'CAPA-003');
      expect(stock).toBeGreaterThanOrEqual(0);
      expect(stock).toBe(0);
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-02 — busca produto único por ID', async () => {
    const e = await bootE2E();
    try {
      const res = await request(e.http).get('/products/CAPA-001').expect(200);
      expect(res.body.id).toBe('CAPA-001');
      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('priceCents');
      expect(res.body).toHaveProperty('stock');
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-03 — produto inexistente retorna 404 no schema de erro', async () => {
    const e = await bootE2E();
    try {
      const res = await request(e.http).get('/products/NAO-EXISTE').expect(404);
      expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('correlationId');
      expect(res.body).toHaveProperty('timestamp');
    } finally {
      await e.close();
    }
  });

  it('TC-PROD-09 — catálogo sob carga concorrente é consistente', async () => {
    const e = await bootE2E();
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => request(e.http).get('/products')),
      );
      const first = JSON.stringify(results[0].body);
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).toBe(first);
      }
      // anti-stampede: single-flight coalesce; poucos misses reais, longe de 50.
      const miss = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      expect(miss).toBeLessThanOrEqual(5);
    } finally {
      await e.close();
    }
  });
});
