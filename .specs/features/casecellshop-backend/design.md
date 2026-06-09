# DESIGN — CaseCellShop Backend

## Arquitetura em camadas (hexagonal leve)

```
interface (HTTP/NestJS controllers, DTOs, Swagger)
   │  correlationId middleware, exception filter, metrics interceptor
application (use-cases: ListProducts, Checkout, GetOrderStatus, Reconcile)
   │  depende de PORTS (interfaces), nunca de implementações
domain (entidades puras + regras: Stock, Order, Idempotency) — sem I/O
infrastructure (ADAPTERS):
   ├─ cache:  RedisCache | InMemoryCache  (port CachePort)
   ├─ queue:  BullMqQueue | InMemoryQueue  (port QueuePort)
   ├─ repo:   InMemoryProductRepo / OrderRepo (port *RepositoryPort) [= "ERP fake"]
   ├─ stock:  RedisStockStore | InMemoryStockStore (port StockPort, reserva atômica)
   ├─ idem:   RedisIdempotencyStore | InMemoryIdempotencyStore (port IdempotencyPort)
   └─ erp:    FakeErpClient (latência + falha aleatória) (port ErpPort)
observability: pino logger, prom-client registry, otel tracer
```

Seleção de adapter por env: `CACHE_DRIVER`/`QUEUE_DRIVER` = `redis|memory`
(default `memory` p/ testes; compose seta `redis`).

## Módulos NestJS
- `AppModule` → importa `ObservabilityModule`, `CatalogModule`, `CheckoutModule`, `OrdersModule`,
  `HealthModule`.
- `ObservabilityModule`: LoggerModule (nestjs-pino), MetricsService (prom-client), TracingService.
- `CatalogModule`: ProductsController, ListProductsUseCase, CachePort, ProductRepoPort.
- `CheckoutModule`: CheckoutController, CheckoutUseCase, StockPort, IdempotencyPort, QueuePort,
  OrderRepoPort, CheckoutWorker (Bull processor / in-memory consumer), ReconcileUseCase.
- `OrdersModule`: OrdersController, GetOrderStatusUseCase, OrderRepoPort.

## Domínio (puro, testável sem I/O)
- `Product { id, name, priceCents, stock }`
- `Order { id, items, status, history[], idempotencyKey, createdAt }`
  - status: `PENDING → PROCESSING → CONFIRMED | FAILED`
- `OrderStatus` enum + `transition(order, next)` com validação de máquina de estados.
- `StockReservation`: lógica de "reservar N se disponível" expressa como função pura sobre um
  número; a atomicidade real é responsabilidade do StockPort (Redis Lua / mutex in-memory).

## Reserva de estoque atômica (FR-8, AC-3)
**StockPort.reserve(productId, qty): {ok, remaining}**
- Redis: script Lua — `if redis.call('GET',k) >= qty then DECRBY k qty; return 1 else return 0`.
- In-memory: operação síncrona (Node single-thread garante atomicidade por tick); para o
  teste de concorrência, disparar N reserves em paralelo via Promise.all e contar sucessos.
- `release(productId, qty)`: INCRBY (compensação em falha do worker).
Métrica `oversell_prevented_total` incrementa em cada reserve negada.

## Idempotência (FR-7, AC-4)
- Header `Idempotency-Key` obrigatório no POST /checkout (se ausente, geramos um e logamos —
  documentado; recomendado cliente enviar).
- `IdempotencyPort.remember(key, factory)`:
  - Redis: `SET key <orderId> NX EX <ttl>`; se já existe ⇒ retorna orderId existente.
  - In-memory: Map com lock.
- Garante 1 pedido + 1 reserva por key. Retry/duplo-clique ⇒ 202 com mesmo orderId.

## Ordem das operações no checkout (FR-6, D7 — anti pedido/mensagem fantasma)
1. Resolve idempotência (se key conhecida ⇒ retorna pedido existente).
2. **Reserva estoque atômica** (falha ⇒ 409, nada persiste).
3. **Grava Order PENDING** (origem da verdade) — antes de enfileirar.
4. **Enfileira** job `{ orderId }` (a fila funciona como outbox lógico).
5. Responde 202 `{ orderId, status: PENDING }`.
- Se o enfileiramento falhar após gravar: pedido fica PENDING e a **reconciliação** (FR-11)
  re-enfileira. Worker é **idempotente** (checa status antes de processar) ⇒ mensagem
  duplicada não dupla-fatura. Isso reduz pedido-fantasma (sempre há registro) e
  mensagem-fantasma (worker idempotente + reconciliação).

## Worker (FR-9)
- Consome job → carrega Order → se já CONFIRMED/FAILED, ignora (idempotente).
- `PENDING→PROCESSING`, chama `FakeErpClient.invoice(order)` (latência 50–300ms, ~30% falha).
- Sucesso ⇒ CONFIRMED. Falha ⇒ BullMQ retry (3x, backoff exponencial). Esgotado ⇒ FAILED +
  `StockPort.release` (compensação). Em memória: reimplementa retry/backoff equivalente.
- Métricas: worker_jobs_total{result}, worker_duration_seconds, queue_depth (gauge).

## Reconciliação (FR-11)
- `ReconcileUseCase`: varre OrderRepo por PENDING mais velhos que `RECONCILE_AGE_MS` sem job
  ativo ⇒ re-enfileira; se exceder `MAX_AGE` ⇒ FAILED + release. Exposto via
  `POST /admin/reconcile` (e/ou intervalo via @Interval).

## Observabilidade (OBS-1..4)
- **Logs** (nestjs-pino): base fields `correlationId`, `service`, `env`; por request: método,
  rota, status, durationMs; checkout/worker logam `orderId`. CorrelationId via
  `AsyncLocalStorage` (propaga ao worker pelo payload do job).
- **Métricas** (prom-client) em `/metrics` — ver SPEC OBS-2.
- **Traces** (OpenTelemetry): tracer com spans `http.request`, `cache.get`, `erp.invoice`,
  `worker.process`. Exporter: console por default; OTLP se `OTEL_EXPORTER_OTLP_ENDPOINT` set
  (Datadog Agent compatível). Stub justificado no README.

## Contrato (FR-12)
- `@nestjs/swagger` decorators nos DTOs/controllers; SwaggerModule em `/docs`.
- Script `npm run openapi` gera `openapi.json` (boot app em modo gerador → escreve arquivo).
- DTOs de erro padronizados via exception filter → `{ statusCode, error, message, correlationId }`.

## Estratégia de testes (NFR-1)
- **Unit (domain)**: state machine de Order; StockReservation; idempotência (Map adapter).
- **Integração (in-memory adapters, sem Docker)**:
  - cache hit/miss + TTL + single-flight (stampede).
  - overselling: 50 reserves concorrentes p/ estoque 10 ⇒ 10 ok / 40 negadas.
  - idempotência: 5 POSTs mesma key ⇒ 1 order.
  - fluxo checkout→worker→status (worker in-memory determinístico com falha forçada p/ testar
    retry + compensação).
- **Redis e2e (opcional)**: guardado por `REDIS_E2E=1` (skip por default).
- Runner: Jest (preset ts-jest) + Supertest para HTTP.

## Estrutura de pastas
```
src/
  main.ts  app.module.ts
  domain/ { order.ts, product.ts, stock.ts, errors.ts }
  application/ ports/*.port.ts  use-cases/*.usecase.ts
  infrastructure/ cache/ queue/ stock/ idempotency/ repo/ erp/ config/
  interface/ http/ controllers + dtos + filters + interceptors + middleware
  observability/ logger.ts metrics.ts tracing.ts
test/ unit/ integration/
docker-compose.yml  Dockerfile  .env.example
```

## Decisões de risco / simplificações (p/ README)
- ERP fake em memória (sem MySQL real) — read model simulado.
- Single-flight in-memory por Promise dedupe; em Redis usaria SETNX lock + jitter.
- Reconciliação por @Interval simplificada (sem scheduler distribuído).
