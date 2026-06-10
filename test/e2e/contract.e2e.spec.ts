import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootE2E, E2EApp } from '../support/harness';
import { postCheckout } from '../support/helpers';

/**
 * TC-CONTRACT — Contrato OpenAPI. P0: documento disponível, schemas de sucesso e
 * de erro descritos, e respostas reais aderentes a esses schemas.
 */
describe('TC-CONTRACT — OpenAPI (e2e)', () => {
  let e: E2EApp;

  beforeAll(async () => {
    e = await bootE2E({ swagger: true });
  });
  afterAll(async () => {
    await e?.close();
  });

  it('TC-CONTRACT-01 — documento OpenAPI disponível em /docs-json', async () => {
    const res = await request(e.http).get('/docs-json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths['/products']).toBeDefined();
    expect(res.body.paths['/checkout']).toBeDefined();
    expect(res.body.paths['/orders/{orderId}/status']).toBeDefined();
  });

  it('TC-CONTRACT-02 — schemas de sucesso documentados (200/202)', () => {
    const paths = e.doc.paths;
    expect(paths['/products'].get.responses['200']).toBeDefined();
    expect(paths['/checkout'].post.responses['202']).toBeDefined();
    expect(paths['/orders/{orderId}/status'].get.responses['200']).toBeDefined();
  });

  it('TC-CONTRACT-03 — schema de erro documentado e consistente', () => {
    const schemas = e.doc.components.schemas;
    expect(schemas.ErrorDto).toBeDefined();
    const props = schemas.ErrorDto.properties;
    for (const f of ['statusCode', 'error', 'message', 'correlationId', 'timestamp']) {
      expect(props[f]).toBeDefined();
    }
    // rotas declaram respostas de erro 4xx
    expect(e.doc.paths['/checkout'].post.responses['400']).toBeDefined();
    expect(e.doc.paths['/orders/{orderId}/status'].get.responses['404']).toBeDefined();
  });

  it('TC-CONTRACT-04 — resposta real de /products adere ao schema', async () => {
    const res = await request(e.http).get('/products').expect(200);
    for (const p of res.body) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.priceCents).toBe('number');
      expect(typeof p.stock).toBe('number');
      expect(typeof p.available).toBe('boolean');
    }
  });

  it('TC-CONTRACT-05 — resposta de erro real adere ao schema (404)', async () => {
    const res = await request(e.http).get(`/orders/${randomUUID()}/status`).expect(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      error: expect.any(String),
      message: expect.any(String),
      correlationId: expect.any(String),
      timestamp: expect.any(String),
    });
    // não vaza stacktrace
    expect(res.body).not.toHaveProperty('stack');
  });

  it('TC-CONTRACT-06 — códigos HTTP corretos por cenário', async () => {
    await request(e.http).get('/products').expect(200);
    await postCheckout(
      e.http,
      { items: [{ productId: 'CAPA-001', quantity: 1 }] },
      'contract-06-ok',
    ).expect(202);
    await postCheckout(e.http, { items: [] }, 'contract-06-bad').expect(400);
    await request(e.http).get(`/orders/${randomUUID()}/status`).expect(404);
    await postCheckout(
      e.http,
      { items: [{ productId: 'CAPA-004', quantity: 1 }] }, // estoque 0
      'contract-06-409',
    ).expect(409);
    await e.queue.drain();
    // o doc também declara esses códigos
    expect(e.doc.paths['/checkout'].post.responses['202']).toBeDefined();
    expect(e.doc.paths['/checkout'].post.responses['400']).toBeDefined();
    expect(e.doc.paths['/checkout'].post.responses['409']).toBeDefined();
  });

  it('TC-CONTRACT-07 — header de idempotência documentado no OpenAPI', () => {
    const params = e.doc.paths['/checkout'].post.parameters ?? [];
    const header = params.find(
      (p: { name: string; in: string }) => p.in === 'header' && p.name === 'Idempotency-Key',
    );
    expect(header).toBeDefined();
    expect(header.description).toBeTruthy();
  });
});
