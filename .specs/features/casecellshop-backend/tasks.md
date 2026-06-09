# TASKS — CaseCellShop Backend

Convenção: `[P]` = paralelizável. Cada task tem Done-when + Tests + Gate (`npm run build`+`npm test`).

## T01 — Scaffold projeto NestJS + tooling
- What: package.json, tsconfig, nest-cli, jest, eslint/prettier, estrutura de pastas, main.ts/app.module.ts mínimos.
- Done when: `npm install` ok; `npm run build` compila; `npm test` roda (mesmo sem testes).
- Reuses: —  | Maps: NFR-1, NFR-3

## T02 — Domínio puro (Product, Order, Stock, errors) [P após T01]
- What: src/domain — entidades, OrderStatus state machine `transition()`, StockReservation, erros de domínio.
- Done when: unit tests do domínio passam.
- Tests: order.spec (transições válidas/ inválidas), stock.spec (reserve/release).
- Maps: FR-6, FR-8, FR-9

## T03 — Ports (interfaces) [P após T01]
- What: application/ports — CachePort, QueuePort, StockPort, IdempotencyPort, ProductRepoPort, OrderRepoPort, ErpPort.
- Done when: compila; usados pelos use-cases.
- Maps: NFR-3

## T04 — Adapters in-memory + config driver-select
- What: InMemoryCache (TTL+single-flight), InMemoryQueue, InMemoryStockStore (reserve atômico),
  InMemoryIdempotencyStore, InMemoryProductRepo (seed), InMemoryOrderRepo, FakeErpClient. ConfigModule lê drivers.
- Done when: integração cache hit/miss e overselling passam.
- Tests: cache.int.spec, stock-concurrency.int.spec.
- Maps: FR-3,4,7,8; AC-1,3,4

## T05 — Adapters Redis (cache ioredis, idempotência SETNX, stock Lua) + BullMQ queue
- What: RedisCache, RedisIdempotencyStore, RedisStockStore (Lua), BullMqQueue + processor. Guardado por env.
- Done when: compila; e2e Redis guardado por REDIS_E2E (skip default).
- Maps: D2, NFR-2

## T06 — Observabilidade (logger pino, metrics prom-client, tracing otel)
- What: ObservabilityModule; correlationId middleware (AsyncLocalStorage); MetricsService + /metrics; TracingService spans.
- Done when: /metrics expõe counters; logs JSON com correlationId.
- Tests: metrics endpoint smoke; correlationId presente no log.
- Maps: OBS-1,2,3; AC-6

## T07 — Use-cases (ListProducts, Checkout, GetOrderStatus, Reconcile)
- What: application/use-cases orquestrando ports; ordem grava-antes-de-enfileirar; compensação.
- Done when: fluxo checkout→worker→status verde em teste.
- Tests: checkout-flow.int.spec (retry+compensação), idempotency.int.spec.
- Maps: FR-6,7,9,10,11; AC-2,4

## T08 — Interface HTTP (controllers, DTOs, Swagger, exception filter)
- What: ProductsController, CheckoutController (202 + Idempotency-Key), OrdersController, AdminController(reconcile);
  DTOs com @ApiProperty; global exception filter padronizado; SwaggerModule /docs.
- Done when: Supertest cobre 200/202/404/409/422; /docs responde.
- Tests: http.e2e.spec.
- Maps: FR-1,2,6,10,12; AC-2,5

## T09 — Worker (BullMQ processor / in-memory consumer)
- What: CheckoutWorker idempotente; retry/backoff; FakeErp falha forçável; métricas worker.
- Done when: teste de retry→CONFIRMED e esgotamento→FAILED+release.
- Maps: FR-9; AC-2,3

## T10 — Export OpenAPI + script
- What: `npm run openapi` gera openapi.json; commitar.
- Done when: openapi.json válido gerado.
- Maps: FR-12, AC-5

## T11 — Infra: Dockerfile, docker-compose (app+redis), .env.example
- Done when: arquivos presentes e coerentes (não executável sem Docker aqui — documentado).
- Maps: NFR-2,4

## T12 — Parte 1.A: RESPOSTAS-CONCEITUAIS.md (5 perguntas) [P — pode delegar]
- Done when: 5 respostas completas, PT-BR, com trade-offs e arquitetura 30–90 dias.
- Maps: Parte 1.A

## T13 — README + PROMPTS.md (runbook/alerta/dashboard, como rodar, trade-offs)
- Done when: README executável; PROMPTS.md com prompts usados.
- Maps: OBS-4, entrega

## T14 — git init + commits atômicos + verificação final
- Done when: build+test verdes; histórico de commits coerente.
- Maps: D4

## Ordem / paralelismo
T01 → (T02[P], T03[P]) → T04 → (T06, T07) → T08 → T09 → (T05[P], T10, T11) → T12[P] ‖ → T13 → T14
