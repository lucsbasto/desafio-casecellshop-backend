import request from 'supertest';
import { PRODUCT_REPO_PORT } from '../../src/application/ports/repository.port';
import { Product } from '../../src/domain/product';
import { PRODUCT_SEED } from '../../src/infrastructure/repo/in-memory-product.repo';
import { bootE2E } from '../support/harness';
import { getMetrics, metricValue, postCheckout, productStock } from '../support/helpers';

/**
 * TC-CACHE — Comportamento de cache. P0: janela TTL, "invalidação" da
 * disponibilidade após mutação e fallback (stale-on-error) quando a fonte falha.
 */
describe('TC-CACHE — Cache (e2e)', () => {
  it('TC-CACHE-01 — TTL respeitado: 1 MISS + N HITs na janela', async () => {
    const e = await bootE2E();
    try {
      for (let i = 0; i < 5; i++) await request(e.http).get('/products').expect(200);
      const metrics = await getMetrics(e.http);
      expect(metricValue(metrics, 'cache_requests_total', { result: 'miss' })).toBe(1);
      expect(metricValue(metrics, 'cache_requests_total', { result: 'hit' })).toBe(4);
    } finally {
      await e.close();
    }
  });

  it('TC-CACHE-02 — disponibilidade reflete mutação de estoque dentro do TTL', async () => {
    const e = await bootE2E({ env: { PRODUCTS_CACHE_TTL_MS: '15000' } });
    try {
      const before = await productStock(e.http, 'CAPA-005');
      await postCheckout(
        e.http,
        { items: [{ productId: 'CAPA-005', quantity: 1 }] },
        'cache-02',
      ).expect(202);
      await e.queue.drain();
      // Mesmo dentro do TTL (catálogo cacheado), a disponibilidade deve estar viva.
      const after = await productStock(e.http, 'CAPA-005');
      expect(after).toBe(before - 1);
    } finally {
      await e.close();
    }
  });

  it('TC-CACHE-03 — fallback (stale) quando a fonte falha após popular o cache', async () => {
    // Toggle explícito: a fonte só passa a falhar DEPOIS que o cache foi populado.
    // (o StockSeeder também consome o repo no boot, então não dá pra contar chamadas).
    const state = { failing: false };
    const failingRepo = {
      async findAll(): Promise<Product[]> {
        if (state.failing) throw new Error('ERP indisponível');
        return PRODUCT_SEED.map((p) => ({ ...p }));
      },
      async findById(id: string): Promise<Product | undefined> {
        return PRODUCT_SEED.find((p) => p.id === id);
      },
    };

    const e = await bootE2E({
      env: { PRODUCTS_CACHE_TTL_MS: '80' },
      customize: (b) => b.overrideProvider(PRODUCT_REPO_PORT).useValue(failingRepo),
    });
    try {
      await request(e.http).get('/products').expect(200); // popula o cache
      state.failing = true; // a partir daqui a fonte falha
      await new Promise((r) => setTimeout(r, 150)); // expira o TTL
      const res = await request(e.http).get('/products').expect(200); // fonte falha -> stale
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const metrics = await getMetrics(e.http);
      expect(
        metricValue(metrics, 'cache_requests_total', { result: 'stale' }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-CACHE-04 — hit ratio exposto (hit e miss separados)', async () => {
    const e = await bootE2E();
    try {
      for (let i = 0; i < 4; i++) await request(e.http).get('/products').expect(200);
      const m = await getMetrics(e.http);
      const miss = metricValue(m, 'cache_requests_total', { result: 'miss' });
      const hit = metricValue(m, 'cache_requests_total', { result: 'hit' });
      expect(miss).toBeGreaterThanOrEqual(1);
      expect(hit).toBeGreaterThanOrEqual(1);
      expect(hit + miss).toBeGreaterThanOrEqual(4);
    } finally {
      await e.close();
    }
  });

  it('TC-CACHE-05 — stampede: 100 reads concorrentes coalescem em ~1 chamada à fonte', async () => {
    let calls = 0;
    const slowRepo = {
      async findAll(): Promise<Product[]> {
        calls++;
        await new Promise((r) => setTimeout(r, 50)); // janela p/ o single-flight coalescer
        return PRODUCT_SEED.map((p) => ({ ...p }));
      },
      async findById(id: string): Promise<Product | undefined> {
        return PRODUCT_SEED.find((p) => p.id === id);
      },
    };
    const e = await bootE2E({
      customize: (b) => b.overrideProvider(PRODUCT_REPO_PORT).useValue(slowRepo),
    });
    try {
      const callsAfterBoot = calls; // o StockSeeder já chamou findAll 1x no boot
      const results = await Promise.all(
        Array.from({ length: 100 }, () => request(e.http).get('/products')),
      );
      for (const r of results) expect(r.status).toBe(200);
      // 100 reads simultâneos → no máximo 1 chamada real adicional à fonte.
      expect(calls - callsAfterBoot).toBeLessThanOrEqual(1);
    } finally {
      await e.close();
    }
  });

  it('TC-CACHE-06 — chaveamento por recurso: products:all e products:{id} não colidem', async () => {
    const e = await bootE2E();
    try {
      await request(e.http).get('/products').expect(200); // popula products:all (miss)
      await request(e.http).get('/products').expect(200); // hit
      const missBefore = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      await request(e.http).get('/products/CAPA-001').expect(200); // chave própria → novo miss
      const missAfter = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      expect(missAfter).toBe(missBefore + 1); // não foi servido pela chave products:all
    } finally {
      await e.close();
    }
  });

  it('TC-CACHE-08 — cache sobrevive entre requisições, não entre TTL', async () => {
    // TTL folgado p/ o trecho "sobrevive entre requisições" não expirar sob carga
    // dos workers; depois aguardamos > TTL para provar a expiração.
    const e = await bootE2E({ env: { PRODUCTS_CACHE_TTL_MS: '2000' } });
    try {
      await request(e.http).get('/products').expect(200); // miss
      const hitBefore = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'hit',
      });
      await request(e.http).get('/products').expect(200); // hit (sobrevive entre requisições)
      const hitMid = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'hit',
      });
      expect(hitMid).toBe(hitBefore + 1);
      const missBefore = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      await new Promise((r) => setTimeout(r, 2200)); // > TTL
      await request(e.http).get('/products').expect(200); // novo miss (não sobrevive ao TTL)
      const missAfter = metricValue(await getMetrics(e.http), 'cache_requests_total', {
        result: 'miss',
      });
      expect(missAfter).toBe(missBefore + 1);
    } finally {
      await e.close();
    }
  });

  it.todo('TC-CACHE-07 — driver Redis: requer Docker/Redis (Tier B)');
});
