import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/interface/http/filters/domain-exception.filter';
import { QUEUE_PORT } from '../src/application/ports/queue.port';
import { InMemoryQueueAdapter } from '../src/infrastructure/queue/in-memory-queue.adapter';

/**
 * HTTP contract E2E tests. Runs 100% in-memory (no Docker): NODE_ENV=test and
 * ERP_FAIL_RATE=0 for a deterministic path to CONFIRMED.
 */
describe('CaseCellShop API (e2e)', () => {
  let app: INestApplication;
  let queue: InMemoryQueueAdapter;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ERP_FAIL_RATE = '0';
    process.env.ERP_MIN_LATENCY_MS = '0';
    process.env.ERP_MAX_LATENCY_MS = '0';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();

    queue = app.get(QUEUE_PORT) as InMemoryQueueAdapter;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /products retorna catálogo e usa cache (miss -> hit)', async () => {
    const r1 = await request(app.getHttpServer()).get('/products').expect(200);
    expect(Array.isArray(r1.body)).toBe(true);
    expect(r1.body.length).toBeGreaterThan(0);
    expect(r1.body[0]).toHaveProperty('priceCents');

    // 2nd call should be a hit; confirmed by the metric.
    await request(app.getHttpServer()).get('/products').expect(200);
    const metrics = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(metrics.text).toContain('cache_requests_total');
    expect(metrics.text).toMatch(/cache_requests_total\{result="hit"\} [1-9]/);
  });

  it('GET /products/:id inexistente => 404 com schema de erro', async () => {
    const res = await request(app.getHttpServer()).get('/products/NAO-EXISTE').expect(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'PRODUCT_NOT_FOUND',
    });
    expect(res.body).toHaveProperty('correlationId');
  });

  it('POST /checkout => 202 Accepted com orderId/status PENDING', async () => {
    const res = await request(app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', 'e2e-1')
      .send({ items: [{ productId: 'CAPA-001', quantity: 1 }] })
      .expect(202);

    expect(res.body).toMatchObject({ status: 'PENDING', replay: false });
    expect(res.body.orderId).toBeDefined();

    // Waits for the worker to process and confirms via GET /status.
    await queue.drain();
    const status = await request(app.getHttpServer())
      .get(`/orders/${res.body.orderId}/status`)
      .expect(200);
    expect(status.body.status).toBe('CONFIRMED');
    expect(status.body.history.length).toBeGreaterThanOrEqual(2);
  });

  it('POST /checkout idempotente: mesma key => replay=true, mesmo orderId', async () => {
    const first = await request(app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', 'e2e-dup')
      .send({ items: [{ productId: 'CAPA-005', quantity: 1 }] })
      .expect(202);

    const second = await request(app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', 'e2e-dup')
      .send({ items: [{ productId: 'CAPA-005', quantity: 1 }] })
      .expect(202);

    expect(second.body.orderId).toBe(first.body.orderId);
    expect(second.body.replay).toBe(true);
    await queue.drain();
  });

  it('POST /checkout sem estoque (CAPA-004 zerado) => 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', 'e2e-nostock')
      .send({ items: [{ productId: 'CAPA-004', quantity: 1 }] })
      .expect(409);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
  });

  it('POST /checkout payload inválido => 400', async () => {
    await request(app.getHttpServer())
      .post('/checkout')
      .set('Idempotency-Key', 'e2e-bad')
      .send({ items: [] })
      .expect(400);
  });

  it('GET /metrics expõe métricas de checkout e worker', async () => {
    const metrics = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(metrics.text).toContain('checkout_requests_total');
    expect(metrics.text).toContain('worker_jobs_total');
    expect(metrics.text).toContain('oversell_prevented_total');
  });
});
