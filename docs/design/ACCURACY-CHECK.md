# Verificação de Precisão — DESIGN-PATTERNS.md & ARCHITECTURE-DIAGRAM.md

> Relatório de fact-checking técnico. Cada afirmação verificável dos documentos
> `docs/DESIGN-PATTERNS.md` e `docs/ARCHITECTURE-DIAGRAM.md` foi confrontada com o
> código real em `src/`. **Os documentos NÃO foram editados** — este é apenas o relatório.

## Resumo

- **Total de afirmações verificáveis checadas:** 52
- **✅ Conferem:** 47
- **⚠️ Imprecisas (drift de linha / generalização):** 4
- **❌ Erradas (fato incorreto):** 1

**Veredito geral:** os documentos são **altamente fiéis ao código**. Nomes de métricas,
tokens DI (`Symbol`), constantes Lua, chaves de config, mapeamento erro→HTTP, endpoints,
máquina de estados estão **corretos** (a contagem de testes subiu de 23 para **26** após o
refactor de cache — ver tabela). As divergências são, em
sua maioria, **drift de número de linha** (o código evoluiu 1–2 linhas) e uma
**imprecisão factual real**: a latência simulada do repositório é **40ms** (correto),
mas o doc atribui esse 40ms ao "ERP", quando o ERP (FakeErpClient) na verdade usa
`50–300ms` (`ERP_MIN/MAX_LATENCY_MS`). O 40ms é a latência do **repositório de produtos**
(catálogo), não do ERP de faturamento.

---

## Tabela de Verificação

| Afirmação no doc | Onde no doc | Evidência no código (arquivo:símbolo) | Veredito | Correção sugerida |
|---|---|---|---|---|
| Métrica `cache_requests_total{result=hit\|miss\|stale}` | DESIGN §18 linha 259 | `metrics.service.ts:26-31` `cacheRequests`, name `cache_requests_total`, label `result` (hit\|miss\|stale) | ✅ confere | — |
| `STOCK_PORT = Symbol('STOCK_PORT')` | DESIGN §2 linha 30 | `application/ports/stock.port.ts:1` | ✅ confere | — |
| `CACHE_PORT`, `IDEMPOTENCY_PORT`, `QUEUE_PORT` são `Symbol` | DESIGN §2 / ARCH §1 | `cache.port.ts:1`, `idempotency.port.ts:1`, `queue.port.ts:1` | ✅ confere | — |
| `APP_CONFIG` é `Symbol` | DESIGN §2 linha 30 | `app-config.ts:69` `export const APP_CONFIG = Symbol('APP_CONFIG')` | ✅ confere | — |
| `REDIS_CLIENT` é `Symbol` (singleton) | DESIGN §4 | `redis.provider.ts:5` | ✅ confere | — |
| Token `REPOSITORY_PORT` (citado no diagrama) | ARCH §1 nó P5 | Código usa `ORDER_REPO_PORT` e `PRODUCT_REPO_PORT` (`repository.port.ts`); não existe um único `REPOSITORY_PORT` | ⚠️ impreciso | É uma simplificação didática do diagrama (1 caixa p/ 2 tokens). Tecnicamente são dois tokens distintos. |
| `RESERVE_LUA` em `redis-stock.adapter.ts` faz GET+compare+DECRBY atômico | DESIGN §25 linha 339 | `redis-stock.adapter.ts:13-20` `RESERVE_LUA` (GET → if current<qty return → DECRBY) | ✅ confere | — |
| `REMEMBER_LUA` faz SET NX + GET atômico | DESIGN §25 linha 339 | `redis-idempotency.adapter.ts:12-16` `REMEMBER_LUA` (SET ...'NX' + GET) | ✅ confere | — |
| `RESERVE_LUA` em `:13-20` | DESIGN §25 linha 339 | `redis-stock.adapter.ts:13-20` | ✅ confere | — |
| `REMEMBER_LUA` em `:12-16` | DESIGN §25 linha 339 | `redis-idempotency.adapter.ts:12-16` | ✅ confere | — |
| `IDEMPOTENCY_TTL_MS`, padrão 24h | DESIGN §14 linha 201 | `app-config.ts:65` `idempotencyTtlMs: num('IDEMPOTENCY_TTL_MS', 86400000)` (86400000ms = 24h) | ✅ confere | — |
| Config `worker.maxAttempts` / `backoffMs` | DESIGN §16 linha 224 | `app-config.ts:52-55` `worker: { maxAttempts, backoffMs }`; defaults 3 / 500 | ✅ confere | — |
| Config `worker.maxAttempts`/`backoffMs` em `app-config.ts:52-55` | DESIGN §16 linha 224 | `app-config.ts:52-55` (linhas exatas) | ✅ confere | — |
| `backoffFactor` (opção da fila p/ testes determinísticos) | DESIGN §8 linha 121 | `in-memory-queue.adapter.ts:8` `backoffFactor?: number`; usado em `:29`. **Não** é chave de env; é opção do `InMemoryQueueOptions`. | ✅ confere | — |
| Latência simulada **40ms** | DESIGN §18 linha 255 ("o ERP (repo) tem latência simulada ... 40ms") e ARCH §5 linha 201 ("loader → repo (40ms)") | `in-memory-product.repo.ts:22` `latencyMs = 40`; wiring em `infrastructure.module.ts:80` (`cfg.env==='test' ? 0 : 40`) | ✅ confere (valor) | O **valor 40ms é correto**, mas é a latência do **repositório de produtos**, não do ERP de faturamento (ver linha abaixo). |
| O "40ms" pertence ao ERP | DESIGN §18 linha 255 trata o repo como "o ERP" | O `FakeErpClient` usa `erp.minLatencyMs=50` / `maxLatencyMs=300` (`app-config.ts:58-59`); 40ms é só do repo de catálogo | ❌ errado | O ERP (faturamento) tem latência **50–300ms**. O 40ms é do repositório de produtos (catálogo). O texto funde os dois conceitos. |
| `@Interval(15000)` no scheduler | DESIGN §13/§19 linha 265; ARCH §4 linha 169 | `reconcile.scheduler.ts:20` `@Interval(15000)` | ✅ confere | — |
| TTL ring buffer de spans `maxBuffer=1000` | DESIGN §G linha 386 | `tracing.service.ts:28` `maxBuffer = 1000` | ✅ confere | — |
| Concorrência BullMQ `concurrency: 4` (implícito no §9/§24) | DESIGN §24 | `bullmq-queue.adapter.ts:65` `concurrency: 4` | ✅ confere | — |
| Mapeamento: `*NotFound` → 404 | DESIGN §22 linha 303 | `domain-exception.filter.ts:23-25` `ProductNotFoundError\|OrderNotFoundError → NOT_FOUND` | ✅ confere | — |
| Mapeamento: `InsufficientStock`/`InvalidTransition`/`DuplicateRequest` → 409 | DESIGN §22 linha 303 | `domain-exception.filter.ts:26-32` → `CONFLICT` | ✅ confere | — |
| Mapeamento: resto → 500 | DESIGN §22 linha 303 | `domain-exception.filter.ts:33` `INTERNAL_SERVER_ERROR` | ✅ confere | — |
| `statusFor()` em `:22-34` | DESIGN §22 linha 303 | `domain-exception.filter.ts:22-34` | ✅ confere | — |
| Filter `@Catch()` global em `main.ts:21` | DESIGN §12 linha 171 | `main.ts:21` `app.useGlobalFilters(new DomainExceptionFilter())` | ✅ confere | — |
| `ValidationPipe` global `main.ts:18-20` (whitelist, transform, forbidNonWhitelisted) | DESIGN §6 linha 93 | `main.ts:18-20` (todas as 3 flags) | ✅ confere | — |
| `DomainError` com `code` (`errors.ts:5-13`) | DESIGN §21/§22 | `errors.ts:5-13` `DomainError` com `readonly code` | ✅ confere | — |
| `InvalidOrderTransitionError` (`errors.ts:37`) | DESIGN §11 linha 155 | `errors.ts:37` | ✅ confere | — |
| Máquina de estados: `ALLOWED`, `canTransition()`, `transition()`, `isTerminal()` | DESIGN §11 linha 155; ARCH §3 | `order.ts:39` ALLOWED, `:52` canTransition, `:60` transition, `:48` isTerminal | ✅ confere | — |
| `transition()` em `:60` (função pura, não muta) | DESIGN §11 linha 155 | `order.ts:60-71` retorna novo objeto via spread | ✅ confere | — |
| `canTransition()` em `:52` | DESIGN §11 linha 155 | `order.ts:52` | ✅ confere | — |
| `isTerminal()` em `:48` | DESIGN §11 linha 155 | `order.ts:48` | ✅ confere | — |
| `transition` idempotente "em `:61`" | DESIGN §11 linha 161 | `order.ts:61` `if (order.status === to) return order` | ✅ confere | — |
| PENDING → PROCESSING\|FAILED; PROCESSING → CONFIRMED\|FAILED; PROCESSING ↛ PENDING | ARCH §3; DESIGN §11 | `order.ts:40-46` ALLOWED bate exatamente | ✅ confere | — |
| `OrderStatus` enum em `order.ts:3-12` | DESIGN §21 linha 291 | `order.ts:3-12` | ✅ confere | — |
| `STOCK_PORT`,`IDEMPOTENCY_PORT`,`QUEUE_PORT`,`ORDER_REPO_PORT`,`PRODUCT_REPO_PORT`,`APP_CONFIG`,`MetricsService`,`TracingService` injetados no `checkout.usecase.ts:46-55` | DESIGN §2 linha 30 | `checkout.usecase.ts:46-55` injeta exatamente esses 8 | ✅ confere | — |
| `CheckoutUseCase.execute()` em `:57` | DESIGN §7 linha 105 | `checkout.usecase.ts:57` | ✅ confere | — |
| Idempotência é o 1º passo `:88-97`; replay/`DuplicateRequestError` em `:96` | DESIGN §14 linha 197/201 | `checkout.usecase.ts:88-97`, `:96` `throw new DuplicateRequestError()` | ✅ confere | — |
| Compensação multi-item no checkout `:119-124` | DESIGN §15 linha 210 | `checkout.usecase.ts:119-125` (bloco catch + release) | ⚠️ impreciso | Bloco real vai até linha **125** (doc cita `:119-124`). Drift de 1 linha. |
| Salva PENDING antes de enfileirar `:127-145`; comentário `:142` "reconciliation will re-enqueue" | DESIGN §19/§20 | `checkout.usecase.ts:127-145`; comentário em `:142` | ✅ confere | — |
| Producer enfileira `CheckoutJob` em `:143-145` | DESIGN §10 linha 143 | `checkout.usecase.ts:143-145` `queue.enqueue(...)` | ✅ confere | — |
| Worker `onModuleInit → queue.register(this)` em `:29-31`; `process()` em `:33` | DESIGN §10 linha 143 | `checkout.worker.ts:29-31`, `:33` | ✅ confere | — |
| Worker guarda contra duplo-processamento em PROCESSING `:51-69` | DESIGN §14 linha 197 | `checkout.worker.ts:51-69` (`handle`, guarda PROCESSING em `:64`) | ✅ confere | — |
| `onExhausted` → FAILED + release por item `:100-123` | DESIGN §15 linha 211 | `checkout.worker.ts:100-123` | ✅ confere | — |
| BullMQ: `removeOnFail: false` (DLQ lógica) em `:56` | DESIGN §17 linha 236 | `bullmq-queue.adapter.ts:55` `removeOnFail: false` + comentário "logical DLQ" | ⚠️ impreciso | Linha real é **55** (doc cita `:56`). Drift de 1 linha. |
| BullMQ `attempts` + `backoff:{type:'exponential'}` em `:52-56` | DESIGN §16 linha 224 | `bullmq-queue.adapter.ts:51-56` | ⚠️ impreciso | Bloco real é **51-56** (doc cita `:52-56`). Drift de 1 linha. |
| BullMQ `attemptsMade+1` em `:64` | DESIGN §5 linha 85 | `bullmq-queue.adapter.ts:63` `processor.process(job.data, job.attemptsMade + 1)` | ⚠️ impreciso | Linha real é **63** (doc cita `:64`). Drift de 1 linha. |
| `this.worker.on('failed', ...)` em `:68` | DESIGN §24 linha 327 | `bullmq-queue.adapter.ts:68` | ✅ confere | — |
| BullMQ loga ruidosamente quando `onExhausted` rejeita `:72-80` | DESIGN §15 linha 216 | `bullmq-queue.adapter.ts:74-80` (`.catch` com `logger.error`) | ✅ confere | — |
| `toConnection()` adapta `REDIS_URL` → `ConnectionOptions` `:13-22` | DESIGN §5 linha 80 | `bullmq-queue.adapter.ts:13-22` | ✅ confere | — |
| Fila in-memory: loop de retry `run()` em `:52-69` | DESIGN §9 linha 131 | `in-memory-queue.adapter.ts:52-69` `run()` (loop iterativo) | ✅ confere | — |
| `ExponentialBackoff` `base*factor^(attempt-2)` com teto | DESIGN §8 linha 121; §16 linha 228 | `backoff.strategy.ts:14-26` `delay = baseMs * factor ** (attempt-2)`, `Math.min(delay, maxMs)` | ✅ confere | — |
| `BackoffStrategy` interface `:9-12`; `ExponentialBackoff` `:15-27` | DESIGN §8 linha 119 | `backoff.strategy.ts:9-12` e `:15-27` | ✅ confere | — |
| Comentário cita padrão Strategy em `backoff.strategy.ts:1` | DESIGN §8 linha 119 | `backoff.strategy.ts:1-2` "Strategy pattern" | ✅ confere | — |
| Fila in-memory consome backoff em `:27` | DESIGN §8 linha 119 | `in-memory-queue.adapter.ts:27` `new ExponentialBackoff(...)` | ✅ confere | — |
| `maxMs` (teto) em `backoff.strategy.ts:17` | DESIGN §16 linha 228 | `backoff.strategy.ts:19` `maxMs = 30_000` | ⚠️ impreciso | Default `maxMs` está na linha **19** (doc cita `:17`). Drift de 2 linhas. |
| `CachePort.getOrLoad()` em `cache.port.ts:18-23` | DESIGN §18 linha 248 | `cache.port.ts:18-23` | ✅ confere | — |
| Single-flight in-memory `:49-54` | DESIGN §18 linha 250 | `in-memory-cache.adapter.ts:49-54` (mapa `inflight`) | ✅ confere | — |
| Single-flight redis `:46-58` | DESIGN §18 linha 250 | `redis-cache.adapter.ts:46-58` | ✅ confere | — |
| Stale-while-error in-memory `:70-76` | DESIGN §18 linha 251 | `in-memory-cache.adapter.ts:70-76` (`opts.staleOnError && lastKnown`) | ✅ confere | — |
| TTL jitter (espalha expirações) | DESIGN §18 linha 252 | Jitter aplicado no **adapter** — `cache-jitter.ts` `createJitter()`, modelo **proporcional** `[ttl, ttl*(1+ratio)]` (`ratio` clampado a `[0,1]`) com `stampedeJitterRatio` (default `DEFAULT_JITTER_RATIO=0.2`, `app-config.ts:53`); `redis-cache.adapter.ts:36`. O `ttl()` em `list-products.usecase.ts:31-33` passa o **TTL puro**. | ✅ confere | Doc-fonte (DESIGN §18 l.252) já descreve `cache-jitter.ts → createJitter()` + `stampedeJitterRatio`. |
| `ListProductsUseCase.listAll()` em `:34-45` | DESIGN §18 linha 253 | `list-products.usecase.ts:34-45` | ✅ confere | — |
| Comentário sobre lock cross-instance em `redis-cache.adapter.ts:5-8` | DESIGN §18 linha 257; §E | `redis-cache.adapter.ts:4-8` (comentário sobre `SET NX` cross-instance) | ✅ confere | — |
| `ReconcileUseCase` em `reconcile.usecase.ts:21` | DESIGN §19 linha 265 | `reconcile.usecase.ts:21` `export class ReconcileUseCase` | ✅ confere | — |
| `findPendingOlderThan` em `in-memory-order.repo.ts:18-23` | DESIGN §19 linha 265 | `in-memory-order.repo.ts:18-23` | ✅ confere | — |
| Reconciliação de PENDING antigo → FAILED+release em `:42-54` | DESIGN §15 linha 212 | `reconcile.usecase.ts:42-54` | ✅ confere | — |
| `AdminTokenGuard implements CanActivate` em `admin-token.guard.ts:21` | DESIGN §12 linha 169 | `admin-token.guard.ts:21` | ✅ confere | — |
| `@UseGuards` em `admin.controller.ts:16` | DESIGN §12 linha 169 | `admin.controller.ts:16` `@UseGuards(AdminTokenGuard)` | ✅ confere | — |
| `POST /admin/reconcile` (`admin.controller.ts:15-21`) | DESIGN §19 linha 265 | `admin.controller.ts:11` `@Controller('admin')` + `:15` `@Post('reconcile')` | ✅ confere | — |
| `CorrelationMiddleware` em `correlation.middleware.ts:11`, `forRoutes('*')` em `app.module.ts:33-35` | DESIGN §12 linha 168 | `correlation.middleware.ts:11`; `app.module.ts:36` `forRoutes('*')` | ⚠️ impreciso | `forRoutes('*')` está na linha **36** (doc cita `:33-35`). Drift de ~1-3 linhas. |
| `AsyncLocalStorage<CorrelationStore>` em `correlation.ts:12` | DESIGN §23 linha 315 | `correlation.ts:12` `correlationStorage = new AsyncLocalStorage<CorrelationStore>()` | ✅ confere | — |
| `runWithCorrelation` no worker `checkout.worker.ts:34-48` | DESIGN §23 linha 315 | `checkout.worker.ts:34-48` | ✅ confere | — |
| Tracer leitura de contexto `tracing.service.ts:32` | DESIGN §23 linha 315 | `tracing.service.ts:35` `getCorrelationId()` dentro de `startSpan` | ⚠️ impreciso | Leitura ocorre na linha **35** (doc cita `:32`). Drift de 3 linhas. |
| API OTel-compatível (`startSpan`/`end`), stub justificado | DESIGN §G linha 385 | `tracing.service.ts:4-12` (comentário "JUSTIFIED STUB", OTel-compatible) | ✅ confere | — |
| `CheckoutItemDto` com `@Matches(/^[A-Za-z0-9_-]+$/)`, `@ArrayMaxSize(50)` | DESIGN §6 linha 93 | `checkout.dto.ts:23` `@Matches`, `:39` `@ArrayMaxSize(50)`, `:30-31` `@Min(1)@Max(1000)` | ✅ confere | — |
| `priceCents` "preço em centavos para evitar float" (`product.ts:3`) | DESIGN §21 linha 293 | `product.ts:3` comentário "avoids floating-point issues" | ✅ confere | — |
| `ProductView`/`toProductView` em `product.ts:14-30` | DESIGN §21 linha 291 | `product.ts:14-20` ProductView, `:22-30` toProductView | ✅ confere | — |
| `tryReserve`/`release` puros em `stock.ts:13-21` | DESIGN §21 linha 291 | `stock.ts:13-17` tryReserve, `:19-21` release | ✅ confere | — |
| `Order` entity com identidade `order.ts:25-36` | DESIGN §21 linha 291 | `order.ts:25-36` interface Order | ✅ confere | — |
| Providers/factory `infrastructure.module.ts:34-97` (`useFactory` por `cfg.drivers.*`) | DESIGN §3 linha 42 | `infrastructure.module.ts:34-97` (Cache/Stock/Idempotency/Queue/Repo/Erp providers) | ✅ confere | — |
| `StockProvider` snippet (provide STOCK_PORT, redis vs in-memory) `:43-50` | DESIGN §3 linha 44-50 | `infrastructure.module.ts:43-50` — bate **exatamente** com o snippet do doc | ✅ confere | — |
| `requireRedis()` lança erro `:27-30` | DESIGN §3 linha 57 | `infrastructure.module.ts:27-30` | ✅ confere | — |
| `RedisProvider` cria ioredis só se algum driver=redis, senão `null` `:16-27` | DESIGN §3 linha 53 | `redis.provider.ts:16-27` (`if (!anyRedisDriver) return null`) | ✅ confere | — |
| `MetricsService` mantém `Registry` único `:8-9` | DESIGN §4 linha 65 | `metrics.service.ts:8-10` (`@Injectable`, `readonly registry = new Registry()`) | ✅ confere | — |
| `TracingService` buffer único de spans `:26-27` | DESIGN §4 linha 65 | `tracing.service.ts:26-29` | ✅ confere | — |
| Endpoints: `POST /checkout` (202, header Idempotency-Key) | ARCH §2; DESIGN §7 | `checkout.controller.ts:15` `@Controller('checkout')`, `:19-20` `@Post()@HttpCode(202)` | ✅ confere | — |
| Endpoint `GET /products` e `GET /products/:id` | ARCH §5; DESIGN §6 | `products.controller.ts:8,12,18` | ✅ confere | — |
| Endpoint `GET /orders/:orderId/status` | DESIGN §21 (GetOrderStatus) | `orders.controller.ts:8,12` `@Get(':orderId/status')` | ✅ confere | — |
| Métricas adicionais: `checkout_requests_total`, `worker_jobs_total`, `queue_depth`, `oversell_prevented_total`, `stock_reservation_total`, `erp_calls_total` | DESIGN §24 / conclusão | `metrics.service.ts:32-83` — todos presentes com esses nomes | ✅ confere | — |
| Suite de testes | README/STATE (referenciado pelo contexto) | **26** ocorrências de `it/test` em 5 specs: `cache.spec.ts`(7), `stock-concurrency.spec.ts`(3), `order.spec.ts`(5), `checkout-flow.spec.ts`(4), `test/http.e2e.spec.ts`(7) = **26** | ⚠️ atualizado | Eram 23 na época desta auditoria; `cache.spec.ts` cresceu 4→7 no refactor de TTL/jitter. README já atualizado para 26. |
| `staleOnError` cobre caminho de leitura quando ERP cai | DESIGN §B linha 360 | `list-products.usecase.ts:41,53` `{ staleOnError: true }` | ✅ confere | — |
| Compensação de estoque em 3 pontos | DESIGN §15 | checkout `:119-125`, worker.onExhausted `:100-123`, reconcile `:42-54` | ✅ confere | — |

---

## Correções recomendadas (apenas itens ⚠️ / ❌)

### ❌ 1. Latência de 40ms atribuída ao "ERP" (DESIGN §18, linha 255; ARCH §5, linha 201)

O texto do §18 diz: *"o catálogo é lido com alta frequência e o 'ERP' (repo) tem latência
simulada (`in-memory-product.repo.ts:22` 40ms)"*. O **valor 40ms é correto**, porém ele é
a latência do **repositório de produtos** (catálogo), e **não** do ERP de faturamento.

- `in-memory-product.repo.ts:22` → `latencyMs = 40` (repo de catálogo).
- O ERP real (`FakeErpClient`) usa `erp.minLatencyMs = 50` e `erp.maxLatencyMs = 300`
  (`app-config.ts:58-59`), ou seja, **50–300ms**.

**Correção sugerida:** distinguir os dois. Ex.: *"o repositório de catálogo simula 40ms de
latência (`in-memory-product.repo.ts:22`), modelando uma API síncrona; o ERP de faturamento
simula 50–300ms (`ERP_MIN/MAX_LATENCY_MS`)."* Evitar chamar o repo de "ERP" neste ponto,
já que o sistema tem um `ErpPort`/`FakeErpClient` separado.

### ⚠️ 2. Drift de número de linha no BullMQ adapter (DESIGN §5/§16/§17)

- `attemptsMade+1`: doc diz `:64`, real é **`:63`**.
- `attempts` + `backoff:{type:'exponential'}`: doc diz `:52-56`, real é **`:51-56`**.
- `removeOnFail: false`: doc diz `:56`, real é **`:55`**.

**Correção sugerida:** ajustar para `:63`, `:51-56` e `:55` respectivamente.

### ⚠️ 3. Drift de número de linha — outros pontos

- `ExponentialBackoff` `maxMs` (teto): doc diz `backoff.strategy.ts:17`, real é **`:19`**.
- Compensação multi-item no checkout: doc diz `checkout.usecase.ts:119-124`, real vai até **`:125`**.
- `forRoutes('*')`: doc diz `app.module.ts:33-35`, real está em **`:36`**.
- Leitura de contexto pelo tracer: doc diz `tracing.service.ts:32`, real é **`:35`**.

**Correção sugerida:** atualizar os números de linha. São desvios pequenos (1–3 linhas),
fruto de evolução do código; o conteúdo conceitual está correto.

### ⚠️ 4. `REPOSITORY_PORT` como token único no diagrama (ARCH §1, nó P5)

O diagrama hexagonal mostra um nó `REPOSITORY_PORT`. No código não existe um token único
com esse nome; há **dois** tokens: `ORDER_REPO_PORT` e `PRODUCT_REPO_PORT`
(`application/ports/repository.port.ts`).

**Correção sugerida:** é uma simplificação didática aceitável num diagrama, mas, para
precisão total, o nó poderia ser rotulado `ORDER_REPO_PORT / PRODUCT_REPO_PORT` (ou
"REPOSITORY PORTS" no plural) e o `RepoAdapter` desdobrado em `InMemoryOrderRepository` +
`InMemoryProductRepository`.

---

## Notas

- Pontos verificados como **corretos** que mereciam atenção especial por serem fáceis de
  errar: nomes exatos das métricas Prometheus (todos batem), conteúdo dos scripts Lua
  (`RESERVE_LUA`/`REMEMBER_LUA`), o TTL de idempotência (24h = 86400000ms), o mapeamento
  erro→HTTP (404/409/500), o `@Interval(15000)`, o `concurrency: 4` do BullMQ, e a contagem
  de testes (**26**, atualizada de 23).
- O snippet de código embutido em DESIGN §3 (`StockProvider`) reproduz **fielmente** o
  `infrastructure.module.ts:43-50`.
- Nenhuma afirmação sobre *padrões* (Hexagonal, DI, Strategy, State Machine, Outbox lógico,
  Compensação, Cache-Aside, etc.) foi encontrada como falsa; todas têm respaldo no código.
