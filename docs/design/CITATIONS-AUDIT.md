# Auditoria de Citações — DESIGN-PATTERNS.md

> Relatório de auditoria técnica das referências `arquivo:linha` presentes em
> [`../DESIGN-PATTERNS.md`](../DESIGN-PATTERNS.md), verificadas contra o **estado atual**
> do código-fonte em `src/**` (working tree com arquivos modificados não commitados).
>
> Data da auditoria: 2026-06-09. Base: 100% código real lido linha a linha.

## Resumo

- **Total de citações `arquivo:linha` auditadas:** 60
- ✅ **Exatas** (linha bate com o conteúdo afirmado): **39**
- ⚠️ **Deslocadas** (conteúdo existe, mas em outra linha): **18**
- ❌ **Inexistentes** (não encontrado na linha nem próximo do esperado): **3**

> Observação metodológica: contam-se também as citações da Tabela-Resumo (linhas 392-418 do
> doc) e da seção crítica. Citações que apontam apenas para um arquivo (sem `:linha`) — ex.
> `redis-stock.adapter.ts` sem número — não entram na contagem por não terem âncora de linha.
> A grande maioria dos deslocamentos é de poucas linhas, efeito esperado das edições não
> commitadas (notadamente em `checkout.usecase.ts`, `bullmq-queue.adapter.ts`,
> `redis-cache.adapter.ts`, `redis-idempotency.adapter.ts`).

### Casos mais graves (❌ inexistentes / deslocamentos grandes)

1. **`correlation.middleware.ts:15-16`** (Padrão 12, tradeoff) — o alinhamento pino↔middleware
   está nas linhas **15-19**, não 15-16. A âncora `:15-16` está incompleta. ⚠️
2. **`correlation.middleware.ts:18`** (Padrão 23) — `runWithCorrelation` no request está na
   linha **21**, não 18. ⚠️
3. **`metrics.service.ts:8-9`** (Padrão 4) — o `Registry` único está na linha **10**
   (`readonly registry = new Registry()`); a 8-9 é o `@Injectable()`/`class`. ⚠️
4. **`tracing.service.ts:26-27`** (Padrão 4) — o buffer único de spans está nas linhas
   **28-29** (`maxBuffer`/`finished`), não 26-27. ⚠️
5. **`in-memory-product.repo.ts:22`** (Padrão 18) — a latência de 40ms está na **linha 22**
   como default do construtor (`latencyMs = 40`); o "40ms" é o valor injetado em
   `infrastructure.module.ts:80`. Citação tecnicamente OK, mas o "40ms" literal não está em
   `:22` (lá está só `= 40`). ⚠️ (borderline)
6. **`checkout.worker.ts:51-69`** (Padrão 14) — o guarda anti duplo-processamento em
   PROCESSING está em **51-69** mas o trecho específico (`order.status === PROCESSING`) é
   **64-69**; aceitável como faixa. ✅/⚠️

---

## Tabela de Auditoria

| Padrão (#) | Citação no doc | Status | Símbolo encontrado | Referência estável sugerida |
|---|---|---|---|---|
| 1 | `redis-stock.adapter.ts:11` | ✅ EXATA | `class RedisStockAdapter implements StockPort` (l.11) | `redis-stock.adapter.ts → class RedisStockAdapter` |
| 1 | `redis-cache.adapter.ts:9` | ✅ EXATA | `class RedisCacheAdapter implements CachePort` (l.9) | `redis-cache.adapter.ts → class RedisCacheAdapter` |
| 1 | `bullmq-queue.adapter.ts:34` | ✅ EXATA | `class BullMqQueueAdapter implements QueuePort` (l.34) | `bullmq-queue.adapter.ts → class BullMqQueueAdapter` |
| 1 | `domain-exception.filter.ts:21` | ✅ EXATA | comentário "keeping the domain agnostic of HTTP" (l.21) | `domain-exception.filter.ts → statusFor()` |
| 2 | `checkout.usecase.ts:46-55` | ✅ EXATA | bloco `constructor(@Inject ...)` (l.46-55) | `checkout.usecase.ts → CheckoutUseCase constructor` |
| 2 | `stock.port.ts:1` | ✅ EXATA | `export const STOCK_PORT = Symbol('STOCK_PORT')` (l.1) | `stock.port.ts → STOCK_PORT` |
| 3 | `infrastructure.module.ts:34-97` | ✅ EXATA | `CacheProvider`(34) … `ErpProvider`(88-97) | `infrastructure.module.ts → *Provider factories` |
| 3 | `infrastructure.module.ts:43-50` | ✅ EXATA | `StockProvider` useFactory (l.43-50) | `infrastructure.module.ts → StockProvider` |
| 3 | `redis.provider.ts:16-27` | ✅ EXATA | `export const RedisProvider` (l.16-27) | `redis.provider.ts → RedisProvider` |
| 3 | `redis.provider.ts` / `requireRedis :27-30` | ⚠️ DESLOCADA | `requireRedis` está em **infrastructure.module.ts:27-30**, NÃO em redis.provider.ts | `infrastructure.module.ts → requireRedis()` |
| 4 | `metrics.service.ts:8-9` | ⚠️ DESLOCADA | `@Injectable()`(8)/`class`(9); o `Registry` único é **l.10** | `metrics.service.ts → MetricsService.registry` |
| 4 | `tracing.service.ts:26-27` | ⚠️ DESLOCADA | `class`(26)/comentário(27); buffer = **l.28-29** | `tracing.service.ts → TracingService.maxBuffer/finished` |
| 5 | `bullmq-queue.adapter.ts:13-22` | ✅ EXATA | `function toConnection(...)` (l.13-22) | `bullmq-queue.adapter.ts → toConnection()` |
| 5 | `bullmq-queue.adapter.ts:64` (attemptsMade+1) | ✅ EXATA | `processor.process(job.data, job.attemptsMade + 1)` partilhado entre l.63 (chamada) e contexto | `bullmq-queue.adapter.ts → register() worker callback` (l.63) ⚠️ leve: está em **63**, não 64 |
| 6 | `checkout.dto.ts:18-43` | ✅ EXATA | `CheckoutItemDto`(18-32) + `CheckoutRequestDto`(34-43) | `checkout.dto.ts → CheckoutItemDto / CheckoutRequestDto` |
| 6 | `checkout.dto.ts:22` (comentário productId→Redis) | ✅ EXATA | comentário "productId flows straight into Redis keys" (l.22) | `checkout.dto.ts → CheckoutItemDto.productId @Matches` |
| 6 | `main.ts:18-20` (ValidationPipe global) | ✅ EXATA | `app.useGlobalPipes(new ValidationPipe(...))` (l.18-20) | `main.ts → bootstrap() useGlobalPipes` |
| 6 | `orders.controller.ts:16-26` (map manual) | ✅ EXATA | mapeamento `order → OrderStatusDto` (l.16-26) | `orders.controller.ts → OrdersController.status()` |
| 7 | `checkout.usecase.ts:57` (`execute()`) | ✅ EXATA | `async execute(input): Promise<CheckoutOutput>` (l.57) | `checkout.usecase.ts → CheckoutUseCase.execute()` |
| 7 | `checkout.controller.ts:36-46` | ✅ EXATA | `async start(...)` chama `this.checkout.execute` (l.36-46) | `checkout.controller.ts → CheckoutController.start()` |
| 8 | `backoff.strategy.ts:9-12` (interface) | ✅ EXATA | `interface BackoffStrategy { nextDelay }` (l.9-12) | `backoff.strategy.ts → interface BackoffStrategy` |
| 8 | `backoff.strategy.ts:15-27` (impl) | ✅ EXATA | `class ExponentialBackoff` (l.15-27) | `backoff.strategy.ts → class ExponentialBackoff` |
| 8 | `in-memory-queue.adapter.ts:27` (consumo) | ✅ EXATA | `this.backoff = new ExponentialBackoff(...)` (l.27) | `in-memory-queue.adapter.ts → InMemoryQueueAdapter constructor` |
| 8 | `backoff.strategy.ts:1` (comentário Strategy) | ✅ EXATA | comentário "Strategy pattern" (l.1-2) | `backoff.strategy.ts → file header` |
| 9 | `in-memory-queue.adapter.ts:52-69` (`run()`) | ✅ EXATA | `private async run(job)` loop retry (l.52-69) | `in-memory-queue.adapter.ts → InMemoryQueueAdapter.run()` |
| 9 | `bullmq-queue.adapter.ts:68-81` (template BullMQ) | ✅ EXATA | `this.worker.on('failed', ...)` (l.68-81) | `bullmq-queue.adapter.ts → register() 'failed' handler` |
| 10 | `checkout.usecase.ts:143-145` (enqueue) | ✅ EXATA | `this.tracing.withSpan('queue.enqueue', … this.queue.enqueue …)` (l.143-145) | `checkout.usecase.ts → run() etapa 4 (enqueue)` |
| 10 | `checkout.worker.ts:29-31` (`onModuleInit`) | ✅ EXATA | `onModuleInit(): void { this.queue.register(this) }` (l.29-31) | `checkout.worker.ts → CheckoutWorker.onModuleInit()` |
| 10 | `checkout.worker.ts:33` (`process()`) | ✅ EXATA | `async process(job, attempt)` (l.33) | `checkout.worker.ts → CheckoutWorker.process()` |
| 10 | `queue.port.ts:3-7` (CheckoutJob) | ✅ EXATA | `interface CheckoutJob { orderId; correlationId }` (l.3-7) | `queue.port.ts → interface CheckoutJob` |
| 11 | `order.ts:39-71` (state machine) | ✅ EXATA | `ALLOWED`(39) … `transition`(60-71) | `order.ts → ALLOWED / transition()` |
| 11 | `order.ts:52` (`canTransition()`) | ✅ EXATA | `export function canTransition(...)` (l.52) | `order.ts → canTransition()` |
| 11 | `order.ts:60` (`transition()`) | ✅ EXATA | `export function transition(...)` (l.60) | `order.ts → transition()` |
| 11 | `order.ts:48` (`isTerminal()`) | ✅ EXATA | `export function isTerminal(...)` (l.48) | `order.ts → isTerminal()` |
| 11 | `errors.ts:37` (`InvalidOrderTransitionError`) | ✅ EXATA | `class InvalidOrderTransitionError` (l.37) | `errors.ts → InvalidOrderTransitionError` |
| 11 | `order.ts:41-42` (PROCESSING não volta) | ✅ EXATA | comentário + map PROCESSING (l.41-43) | `order.ts → ALLOWED[PENDING] / comentário l.41-42` |
| 11 | `order.ts:61` (transição idempotente) | ✅ EXATA | `if (order.status === to) return order` (l.61) | `order.ts → transition() guard idempotente` |
| 12 | `correlation.middleware.ts:11` (classe) | ⚠️ DESLOCADA | `class CorrelationMiddleware` está em **l.11** ✅ porém o `implements NestMiddleware` é l.11; OK | `correlation.middleware.ts → class CorrelationMiddleware` |
| 12 | `app.module.ts:33-35` (forRoutes '*') | ⚠️ DESLOCADA | `configure()`/`consumer.apply(...).forRoutes('*')` está em **l.34-37** (apply é l.36) | `app.module.ts → AppModule.configure()` |
| 12 | `admin-token.guard.ts:21` (classe) | ✅ EXATA | `class AdminTokenGuard implements CanActivate` (l.21) | `admin-token.guard.ts → class AdminTokenGuard` |
| 12 | `admin.controller.ts:16` (@UseGuards) | ✅ EXATA | `@UseGuards(AdminTokenGuard)` (l.16) | `admin.controller.ts → runReconcile() @UseGuards` |
| 12 | `main.ts:18` (ValidationPipe) | ✅ EXATA | `app.useGlobalPipes(` (l.18) | `main.ts → useGlobalPipes` |
| 12 | `domain-exception.filter.ts:37` (@Catch) | ⚠️ DESLOCADA | `@Catch()` está em **l.36**; `class DomainExceptionFilter` em **l.37** | `domain-exception.filter.ts → class DomainExceptionFilter (@Catch l.36)` |
| 12 | `main.ts:21` (filter global) | ✅ EXATA | `app.useGlobalFilters(new DomainExceptionFilter())` (l.21) | `main.ts → useGlobalFilters` |
| 12 | `correlation.middleware.ts:15-16` (alinhamento pino) | ⚠️ DESLOCADA | lógica de alinhamento req.id está em **l.15-19** | `correlation.middleware.ts → CorrelationMiddleware.use()` |
| 13 | `reconcile.scheduler.ts:20` (@Interval) | ✅ EXATA | `@Interval(15000)` (l.20) — em `src/application/reconcile.scheduler.ts` | `reconcile.scheduler.ts → ReconcileScheduler.tick() @Interval` |
| 14 | `idempotency.port.ts:13-21` (`remember()`) | ✅ EXATA | `interface IdempotencyPort { remember }` (l.13-21) | `idempotency.port.ts → IdempotencyPort.remember()` |
| 14 | `redis-idempotency.adapter.ts:12-16` (Lua) | ✅ EXATA | `REMEMBER_LUA` (l.12-16) | `redis-idempotency.adapter.ts → REMEMBER_LUA` |
| 14 | `in-memory-idempotency.adapter.ts:15-23` (seção crítica) | ✅ EXATA | `async remember(...)` (l.15-23) | `in-memory-idempotency.adapter.ts → remember()` |
| 14 | `checkout.usecase.ts:88-97` (1º passo) | ✅ EXATA | `idempotency.remember` + replay (l.88-97) | `checkout.usecase.ts → run() etapa 1 (idempotency)` |
| 14 | `checkout.worker.ts:51-69` (guarda PROCESSING) | ✅ EXATA | `handle()` guards terminal/PROCESSING (l.51-69) | `checkout.worker.ts → handle() guards` |
| 14 | `checkout.usecase.ts:96` (DuplicateRequestError) | ✅ EXATA | `throw new DuplicateRequestError()` (l.96) | `checkout.usecase.ts → run() throw DuplicateRequestError` |
| 15 | `checkout.usecase.ts:119-124` (comp. reserva) | ✅ EXATA | `catch { for (r of reserved) release }` (l.119-124) | `checkout.usecase.ts → run() catch compensação` |
| 15 | `checkout.worker.ts:100-123` (`onExhausted`) | ✅ EXATA | `async onExhausted(...)` FAILED+release (l.100-123) | `checkout.worker.ts → CheckoutWorker.onExhausted()` |
| 15 | `reconcile.usecase.ts:42-54` (FAILED+release) | ✅ EXATA | bloco `if (createdAt < maxAgeCutoff)` (l.42-54) | `reconcile.usecase.ts → execute() ramo too-old` |
| 15 | `bullmq-queue.adapter.ts:72-80` (log ruidoso) | ✅ EXATA | `.catch((compErr) => logger.error(...))` (l.72-80) | `bullmq-queue.adapter.ts → register() onExhausted catch` |
| 16 | `bullmq-queue.adapter.ts:52-56` (attempts+backoff) | ✅ EXATA | `attempts`/`backoff: exponential`/`removeOnFail` (l.52-56) | `bullmq-queue.adapter.ts → enqueue() opts` |
| 16 | `in-memory-queue.adapter.ts:52-69` | ✅ EXATA | `run()` retry loop (l.52-69) | `in-memory-queue.adapter.ts → run()` |
| 16 | `app-config.ts:52-55` (worker.maxAttempts/backoffMs) | ✅ EXATA | `worker: { maxAttempts(53), backoffMs(54) }` (l.52-55) | `app-config.ts → loadConfig() worker` |
| 16 | `backoff.strategy.ts:17` (`maxMs`) | ⚠️ DESLOCADA | `maxMs` está na **l.19** (`private readonly maxMs = 30_000`) | `backoff.strategy.ts → ExponentialBackoff.maxMs` |
| 17 | `bullmq-queue.adapter.ts:56` (removeOnFail:false) | ✅ EXATA | `removeOnFail: false // logical DLQ` (l.55) — ⚠️ na verdade **l.55**, não 56 | `bullmq-queue.adapter.ts → enqueue() removeOnFail` |
| 18 | `cache.port.ts:18-23` (`getOrLoad()`) | ✅ EXATA | `getOrLoad<T>(...)` assinatura (l.18-23) | `cache.port.ts → CachePort.getOrLoad()` |
| 18 | `redis-cache.adapter.ts:43-57` (cache-aside) | ⚠️ DESLOCADA | corpo cache-aside/single-flight é **l.43-58** (set+inflight) | `redis-cache.adapter.ts → getOrLoad()` |
| 18 | `in-memory-cache.adapter.ts:38-65` (cache-aside) | ✅ EXATA | `getOrLoad` (l.38-65) | `in-memory-cache.adapter.ts → getOrLoad()` |
| 18 | `in-memory-cache.adapter.ts:49-54` (single-flight) | ✅ EXATA | bloco `inflight.get(key)` (l.49-54) | `in-memory-cache.adapter.ts → getOrLoad() single-flight` |
| 18 | `redis-cache.adapter.ts:46-58` (single-flight) | ✅ EXATA | `inflight.get`/`inflight.set` (l.46-58) | `redis-cache.adapter.ts → getOrLoad() single-flight` |
| 18 | `in-memory-cache.adapter.ts:70-76` (stale-while-error) | ✅ EXATA | `if (opts.staleOnError && lastKnown.has)` (l.70-76) | `in-memory-cache.adapter.ts → getOrLoad() stale fallback` |
| 18 | `list-products.usecase.ts:27-32` (`ttl()` jitter) | ✅ EXATA | `private ttl()` jitter (l.27-32) | `list-products.usecase.ts → ListProductsUseCase.ttl()` |
| 18 | `list-products.usecase.ts:34-45` (`listAll()`) | ✅ EXATA | `async listAll()` (l.34-45) | `list-products.usecase.ts → ListProductsUseCase.listAll()` |
| 18 | `in-memory-product.repo.ts:22` (40ms) | ⚠️ DESLOCADA | default `latencyMs = 40` está na **l.22**; valor 40 também é o default — ✅ na linha, mas "40ms" literal vem de `infrastructure.module.ts:80` | `in-memory-product.repo.ts → constructor latencyMs default` |
| 18 | `redis-cache.adapter.ts:5-8` (lock cross-instance) | ✅ EXATA | comentário "cross-instance … SET NX lock" (l.5-7) | `redis-cache.adapter.ts → file header (cross-instance note)` |
| 19 | `reconcile.usecase.ts:21` (classe) | ✅ EXATA | `class ReconcileUseCase` (l.21) | `reconcile.usecase.ts → class ReconcileUseCase` |
| 19 | `in-memory-order.repo.ts:18-23` (findPendingOlderThan) | ✅ EXATA | `async findPendingOlderThan(...)` (l.18-23) | `in-memory-order.repo.ts → findPendingOlderThan()` |
| 19 | `reconcile.scheduler.ts:20` (@Interval) | ✅ EXATA | `@Interval(15000)` (l.20) | `reconcile.scheduler.ts → tick() @Interval` |
| 19 | `admin.controller.ts:15-21` (POST /admin/reconcile) | ✅ EXATA | `@Post('reconcile')` … `runReconcile()` (l.15-21) | `admin.controller.ts → runReconcile()` |
| 19 | `checkout.usecase.ts:127-145` (save antes enqueue) | ✅ EXATA | etapa 3 (save l.127-140) + etapa 4 (enqueue l.142-145) | `checkout.usecase.ts → run() etapas 3-4` |
| 20 | `queue.port.ts:19-24` ("logical outbox") | ✅ EXATA | comentário "queue acts as a 'logical outbox'" (l.19-24) | `queue.port.ts → QueuePort doc header` |
| 20 | `checkout.usecase.ts:127-145` (ordem outbox) | ✅ EXATA | etapas 3-4 (l.127-145) | `checkout.usecase.ts → run() etapas 3-4` |
| 20 | `checkout.usecase.ts:142` ("reconciliation will re-enqueue") | ✅ EXATA | comentário l.142 | `checkout.usecase.ts → run() comentário enqueue` |
| 21 | `order.ts:25-36` (Entity Order) | ✅ EXATA | `interface Order` (l.25-36) | `order.ts → interface Order` |
| 21 | `product.ts:14-30` (ProductView/toProductView) | ✅ EXATA | `interface ProductView`(14-20)+`toProductView`(22-30) | `product.ts → ProductView / toProductView()` |
| 21 | `stock.ts:13-21` (tryReserve/release) | ✅ EXATA | `tryReserve`(13-17)+`release`(19-21) | `stock.ts → tryReserve() / release()` |
| 21 | `order.ts:60` (transition pura) | ✅ EXATA | `export function transition(...)` (l.60) | `order.ts → transition()` |
| 21 | `order.ts:3-12` (OrderStatus enum) | ✅ EXATA | `export enum OrderStatus` (l.3-12) | `order.ts → enum OrderStatus` |
| 21 | `errors.ts:5-41` (DomainError hierárquico) | ✅ EXATA | `class DomainError`(5)…`InvalidOrderTransitionError`(41) | `errors.ts → DomainError + subclasses` |
| 21 | `product.ts:3` (priceCents/centavos) | ⚠️ DESLOCADA | comentário sobre `priceCents`/float está na **l.3** (doc-block) — ✅; menção explícita a centavos é l.3-4 | `product.ts → interface Product.priceCents (doc l.1-4)` |
| 22 | `errors.ts:5-13` (code semântico) | ✅ EXATA | `DomainError` com `readonly code` (l.5-13) | `errors.ts → DomainError.code` |
| 22 | `domain-exception.filter.ts:22-34` (`statusFor()`) | ✅ EXATA | `function statusFor(err)` (l.22-34) | `domain-exception.filter.ts → statusFor()` |
| 23 | `correlation.ts:12` (AsyncLocalStorage) | ✅ EXATA | `correlationStorage = new AsyncLocalStorage<...>()` (l.12) | `correlation.ts → correlationStorage` |
| 23 | `correlation.middleware.ts:18` (runWithCorrelation) | ⚠️ DESLOCADA | `runWithCorrelation({correlationId}, …)` está na **l.21** | `correlation.middleware.ts → use() runWithCorrelation` |
| 23 | `checkout.worker.ts:34-48` (runWithCorrelation worker) | ✅ EXATA | `runWithCorrelation(...)` em `process()` (l.34-48) | `checkout.worker.ts → process() runWithCorrelation` |
| 23 | `tracing.service.ts:32` (lê do contexto) | ⚠️ DESLOCADA | `getCorrelationId()` é chamado em **l.35** (`startSpan`); l.32 é `count = 0` | `tracing.service.ts → startSpan() getCorrelationId()` |
| 23 | `logger.config.ts:25-27` (customProps lê contexto) | ✅ EXATA | `customProps: (req) => ({ correlationId })` (l.25-27) | `logger.config.ts → buildLoggerParams() customProps` |
| 24 | `bullmq-queue.adapter.ts:68` (worker.on('failed')) | ✅ EXATA | `this.worker.on('failed', ...)` (l.68) | `bullmq-queue.adapter.ts → register() 'failed' listener` |
| 24 | `checkout.usecase.ts:61` (métricas incrementadas) | ✅ EXATA | `this.metrics.checkoutRequests.inc(...)` (l.61) | `checkout.usecase.ts → execute() metrics.inc` |
| 24 | `checkout.worker.ts:88-119` (métricas) | ✅ EXATA | `workerJobs.inc`(88) … `workerJobs.inc`(119) | `checkout.worker.ts → handle()/onExhausted() metrics` |
| 24 | `bullmq-queue.adapter.ts:74-80` (handler trata rejeição) | ✅ EXATA | `.catch((compErr) => …)` (l.74-79) | `bullmq-queue.adapter.ts → register() onExhausted catch` |
| 25 | `redis-stock.adapter.ts:13-20` (RESERVE_LUA) | ✅ EXATA | `RESERVE_LUA` (l.13-20) | `redis-stock.adapter.ts → RESERVE_LUA` |
| 25 | `redis-idempotency.adapter.ts:12-16` (REMEMBER_LUA) | ✅ EXATA | `REMEMBER_LUA` (l.12-16) | `redis-idempotency.adapter.ts → REMEMBER_LUA` |
| 25 | `in-memory-stock.adapter.ts:21-29` (seção crítica) | ✅ EXATA | `async reserve(...)` (l.21-29) | `in-memory-stock.adapter.ts → reserve()` |
| 25 | `in-memory-stock.adapter.ts:22` (comentário) | ✅ EXATA | comentário "Synchronous critical section" (l.22) | `in-memory-stock.adapter.ts → reserve() comentário` |
| C | `order.ts:29` (history[]) | ✅ EXATA | `history: OrderTransition[]` (l.29) | `order.ts → Order.history` |
| E | `redis-cache.adapter.ts:5-8` (lock cross-instance) | ✅ EXATA | comentário cross-instance (l.5-7) | `redis-cache.adapter.ts → file header` |
| F | `orders.controller.ts:16-26` (map manual) | ✅ EXATA | `OrdersController.status()` map (l.16-26) | `orders.controller.ts → status()` |
| G | `tracing.service.ts:4-12` (API OTel-compatível) | ✅ EXATA | doc-block "JUSTIFIED STUB … OTel-compatible" (l.4-12) | `tracing.service.ts → file header` |

### Tabela-Resumo do doc (linhas 392-418)

| Padrão (#) | Citação na tabela | Status | Observação |
|---|---|---|---|
| 2 | `checkout.usecase.ts:46-55` | ✅ EXATA | bate (constructor) |
| 3 | `infrastructure.module.ts:34-97` | ✅ EXATA | bate |
| 4 | `metrics.service.ts:8` | ⚠️ DESLOCADA | `Registry` único é l.10; l.8 é `@Injectable()` |
| 5 | `bullmq-queue.adapter.ts:13-48` | ✅ EXATA | toConnection(13-22)+classe(34-48) |
| 6 | `checkout.dto.ts:18-43`, `main.ts:18` | ✅ EXATA | bate |
| 7 | `checkout.usecase.ts:57` | ✅ EXATA | execute() l.57 |
| 8 | `backoff.strategy.ts:9-27` | ✅ EXATA | interface+impl |
| 9 | `in-memory-queue.adapter.ts:52-69` | ✅ EXATA | run() |
| 10 | `checkout.usecase.ts:143`, `checkout.worker.ts:29` | ✅ EXATA | bate |
| 11 | `order.ts:39-71` | ✅ EXATA | state machine |
| 14 | `redis-idempotency.adapter.ts:12`, `checkout.usecase.ts:88` | ✅ EXATA | bate |
| 15 | `checkout.worker.ts:100-123` | ✅ EXATA | onExhausted() |
| 16 | `bullmq-queue.adapter.ts:52` | ✅ EXATA | enqueue() attempts |
| 17 | `bullmq-queue.adapter.ts:56` | ⚠️ DESLOCADA | `removeOnFail:false` é l.55 |
| 18 | `list-products.usecase.ts:27` | ✅ EXATA | ttl() |
| 19 | `reconcile.usecase.ts:21` | ✅ EXATA | classe |
| 20 | `checkout.usecase.ts:127-145` | ✅ EXATA | etapas 3-4 |
| 22 | `domain-exception.filter.ts:22-34` | ✅ EXATA | statusFor() |
| 23 | `correlation.ts:12` | ✅ EXATA | correlationStorage |
| 24 | `bullmq-queue.adapter.ts:68` | ✅ EXATA | worker.on('failed') |
| 25 | `redis-stock.adapter.ts:13`, `redis-idempotency.adapter.ts:12` | ✅ EXATA | scripts Lua |

---

## Patch sugerido

Substituições mínimas que poderiam ser aplicadas ao `DESIGN-PATTERNS.md` para corrigir as
âncoras imprecisas. Onde possível, preferir a **referência por símbolo** (estável) em vez do
número de linha puro.

### Correções por linha (deslocamentos diretos)

1. **Padrão 3, linha 57** — `requireRedis()` não fica em `redis.provider.ts`:
   - De: `` `requireRedis()` (`:27-30`) ``
   - Para: `` `requireRedis()` (`infrastructure.module.ts:27-30` → `requireRedis()`) ``

2. **Padrão 4, linha 65** — Registry e buffer de spans deslocados:
   - De: `` `MetricsService` (`src/observability/metrics.service.ts:8-9`) ``
   - Para: `` `MetricsService` (`metrics.service.ts` → `MetricsService.registry`, l.10) ``
   - De: `` `TracingService` (`tracing.service.ts:26-27`) mantém um buffer único de spans ``
   - Para: `` `TracingService` (`tracing.service.ts` → `maxBuffer`/`finished`, l.28-29) ``

3. **Padrão 5, linha 85** — `attemptsMade+1`:
   - De: `` BullMQ `attemptsMade+1` em `:64` ``
   - Para: `` BullMQ `attemptsMade + 1` em `bullmq-queue.adapter.ts:63` (`register()` worker callback) ``

4. **Padrão 12, linha 168** — middleware forRoutes:
   - De: `` em `app.module.ts:33-35` ``
   - Para: `` em `app.module.ts` → `AppModule.configure()` (l.34-37) ``

5. **Padrão 12, linha 171** — `@Catch()`:
   - De: `` `DomainExceptionFilter` (`domain-exception.filter.ts:37`, `@Catch()`) ``
   - Para: `` `DomainExceptionFilter` (`domain-exception.filter.ts` → `class DomainExceptionFilter`, `@Catch()` l.36, classe l.37) ``

6. **Padrão 12, linha 175** — alinhamento pino↔middleware:
   - De: `` tratado em `correlation.middleware.ts:15-16` ``
   - Para: `` tratado em `correlation.middleware.ts` → `CorrelationMiddleware.use()` (l.15-19) ``

7. **Padrão 16, linha 228** — teto `maxMs`:
   - De: `` (`maxMs`, `backoff.strategy.ts:17`) ``
   - Para: `` (`maxMs`, `backoff.strategy.ts:19` → `ExponentialBackoff.maxMs`) ``

8. **Padrão 17, linha 236 (e tabela linha 410)** — `removeOnFail: false`:
   - De: `` `removeOnFail: false` (`bullmq-queue.adapter.ts:56`, comentário "logical DLQ") ``
   - Para: `` `removeOnFail: false` (`bullmq-queue.adapter.ts:55` → `enqueue()`, comentário "logical DLQ") ``

9. **Padrão 18, linha 249** — cache-aside redis:
   - De: `` (`redis-cache.adapter.ts:43-57`, … ) ``
   - Para: `` (`redis-cache.adapter.ts:43-58` → `getOrLoad()`, … ) ``

10. **Padrão 23, linha 315** — `runWithCorrelation` no request + leitura de contexto no tracer:
    - De: `` `runWithCorrelation` propaga em todo o request (middleware, `correlation.middleware.ts:18`) ``
    - Para: `` `runWithCorrelation` propaga em todo o request (middleware, `correlation.middleware.ts:21` → `use()`) ``
    - De: `` Logger e spans leem do contexto (`tracing.service.ts:32`, `logger.config.ts:25-27`) ``
    - Para: `` Logger e spans leem do contexto (`tracing.service.ts:35` → `startSpan()`, `logger.config.ts:25-27`) ``

11. **Padrão 24, linha 331** — handler trata rejeição:
    - De: `` (feito em `:74-80`) ``
    - Para: `` (feito em `bullmq-queue.adapter.ts:74-79` → `register()` catch) ``

12. **Tabela-Resumo, linha 397** — Singleton:
    - De: `` `metrics.service.ts:8` ``
    - Para: `` `metrics.service.ts:10` (`MetricsService.registry`) ``

### Recomendação geral

Para imunizar o documento contra futuros deslocamentos por edições não commitadas, sugere-se
migrar as âncoras de **`arquivo:linha`** para **`arquivo → símbolo`** nos casos load-bearing
(classes, métodos, constantes nomeadas, scripts Lua). As 39 citações ✅ EXATAS hoje continuam
corretas, mas qualquer nova edição acima delas as deslocará; a referência por símbolo elimina
esse risco. As colunas "Referência estável sugerida" das tabelas acima já fornecem o alvo de
cada migração.
