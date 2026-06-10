import type { Server } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { QUEUE_PORT } from '../../src/application/ports/queue.port';
import { InMemoryQueueAdapter } from '../../src/infrastructure/queue/in-memory-queue.adapter';
import { DomainExceptionFilter } from '../../src/interface/http/filters/domain-exception.filter';
import { buildOpenApiDocument } from '../../src/swagger';

/**
 * Deterministic baseline for E2E. Everything in-memory, ERP instant and never
 * failing, backoff disabled, cache jitter off. Individual specs override only the
 * knobs they exercise (TTL, ERP_FAIL_RATE, latency, attempts, ...).
 */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  CACHE_DRIVER: 'memory',
  QUEUE_DRIVER: 'memory',
  STOCK_DRIVER: 'memory',
  IDEMPOTENCY_DRIVER: 'memory',
  ERP_FAIL_RATE: '0',
  ERP_MIN_LATENCY_MS: '0',
  ERP_MAX_LATENCY_MS: '0',
  WORKER_MAX_ATTEMPTS: '3',
  WORKER_BACKOFF_MS: '0',
  PRODUCTS_CACHE_TTL_MS: '15000',
  CACHE_STAMPEDE_JITTER_RATIO: '0',
  LOG_LEVEL: 'silent',
};

/** Env keys the harness manages, so each boot starts from a clean, known slate. */
const MANAGED_KEYS = [
  ...Object.keys(BASE_ENV),
  'SERVICE_NAME',
  'REDIS_URL',
  'RECONCILE_AGE_MS',
  'RECONCILE_MAX_AGE_MS',
  'IDEMPOTENCY_TTL_MS',
];

export interface BootOptions {
  /** Env overrides applied on top of BASE_ENV (read at module-compile time). */
  env?: Record<string, string>;
  /** Build the OpenAPI doc and mount Swagger (needed by TC-CONTRACT). */
  swagger?: boolean;
  /** Hook to override providers (e.g. a failing repo or a scripted ERP). */
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface E2EApp {
  app: INestApplication;
  http: Server;
  queue: InMemoryQueueAdapter;
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPIObject is structurally inspected in contract tests.
  doc?: any;
  close: () => Promise<void>;
}

/**
 * Boots a fresh in-memory Nest app wired exactly like production (`main.ts`):
 * same ValidationPipe and DomainExceptionFilter, optional Swagger. Config is read
 * from env at compile time, so we set env right before compiling.
 */
export async function bootE2E(opts: BootOptions = {}): Promise<E2EApp> {
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.customize) builder = opts.customize(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());

  // biome-ignore lint/suspicious/noExplicitAny: see E2EApp.doc.
  let doc: any;
  if (opts.swagger) {
    doc = buildOpenApiDocument(app);
    SwaggerModule.setup('docs', app, doc);
  }

  // listen() (not just init()) so supertest reuses ONE listening socket instead of
  // spawning an ephemeral listener per request — the latter exhausts sockets and
  // yields ECONNRESET under the high-concurrency scenarios (TC-STOCK-01, TC-E2E-03).
  await app.listen(0);

  const queue = app.get(QUEUE_PORT) as InMemoryQueueAdapter;
  const http = app.getHttpServer() as Server;

  return {
    app,
    http,
    queue,
    doc,
    close: async () => {
      await app.close();
    },
  };
}
