# CaseCellShop — Backend (Desafio Pleno)

Serviço backend que expõe **catálogo com cache**, **checkout assíncrono** (202 Accepted) e
**consulta de status de pedido**, com observabilidade, consistência de estoque e resiliência.

> Empresa fictícia. Implementação do desafio técnico Pleno Backend. As respostas conceituais
> (Parte 1.A) estão em [`docs/RESPOSTAS-CONCEITUAIS.md`](docs/RESPOSTAS-CONCEITUAIS.md).

---

## TL;DR — como rodar

### Opção A — sem Docker (in-memory, recomendado para avaliar rápido)

```bash
npm ci
npm test          # 26 testes: domínio, cache, concorrência/overselling, idempotência, e2e HTTP
npm run build
npm start         # sobe em http://localhost:3000  (Swagger em /docs, métricas em /metrics)
```

Tudo roda **sem dependências externas**: cache, fila, estoque e idempotência usam adapters
in-memory por padrão (`*_DRIVER=memory`).

### Opção B — com Docker (Redis real + fila BullMQ)

```bash
docker compose up --build
# API em http://localhost:3000, Redis em :6379
```

O compose ativa `*_DRIVER=redis`: cache em Redis, reserva de estoque via **Lua atômico**,
idempotência via `SET NX` e fila/worker via **BullMQ**.

> **Nota de transparência:** a máquina onde este projeto foi desenvolvido não tinha Docker
> instalado, então o caminho Redis foi validado por **compilação e revisão**, e o caminho
> in-memory por **testes automatizados completos**. A arquitetura hexagonal garante que os
> dois caminhos compartilham exatamente a mesma lógica de negócio (ver _Arquitetura_).

---

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/products` | Catálogo, servido via **cache-aside + TTL** (single-flight anti-stampede). |
| `GET` | `/products/:id` | Produto individual (cacheado). 404 se inexistente. |
| `POST` | `/checkout` | Inicia compra assíncrona. **202 Accepted** `{ orderId, status, replay }`. Header opcional `Idempotency-Key`. |
| `GET` | `/orders/:orderId/status` | Status atual + histórico de transições do pedido. |
| `POST` | `/admin/reconcile` | Reconciliação manual de pedidos `PENDING` órfãos. |
| `GET` | `/health` | Liveness. |
| `GET` | `/metrics` | Métricas Prometheus. |
| `GET` | `/docs` | Swagger UI (OpenAPI). Contrato também em [`openapi.json`](openapi.json). |

### Exemplos (curl)

```bash
# Catálogo (2ª chamada vem do cache)
curl http://localhost:3000/products

# Checkout assíncrono (idempotente)
curl -i -X POST http://localhost:3000/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pedido-123' \
  -d '{"items":[{"productId":"CAPA-001","quantity":1}]}'
# -> HTTP/1.1 202 Accepted  { "orderId":"...", "status":"PENDING", "replay":false }

# Status do pedido
curl http://localhost:3000/orders/<orderId>/status
```

---

## Arquitetura

Arquitetura **hexagonal (ports & adapters)** em 4 camadas. O domínio é puro; a aplicação
depende de **portas** (interfaces); a infraestrutura provê **adapters** (in-memory ou Redis),
selecionados por variável de ambiente.

> 📐 **Aprofundamento:** [`docs/DESIGN-PATTERNS.md`](docs/DESIGN-PATTERNS.md) — 25 design patterns
> usados (com evidência `arquivo:linha`, tradeoffs e padrões deliberadamente _não_ usados) ·
> [`docs/ARCHITECTURE-DIAGRAM.md`](docs/ARCHITECTURE-DIAGRAM.md) — diagramas Mermaid (hexágono,
> sequência do checkout, máquina de estados, resiliência, cache-aside).

```
interface/   Controllers HTTP, DTOs, Swagger, exception filter, correlation middleware
application/ Use-cases (ListProducts, Checkout, GetOrderStatus, Reconcile) + Worker + Ports
domain/      Entidades e regras puras (Order state machine, reserva de estoque) — sem I/O
infrastructure/ Adapters: cache, queue, stock, idempotency, repo (ERP fake), erp client, config
observability/  pino (logs), prom-client (/metrics), tracing (spans), correlationId (ALS)
```

Troca de driver por env (sem mudar código):

| Recurso | `memory` (default) | `redis` (compose) |
|---|---|---|
| Cache | `InMemoryCacheAdapter` | `RedisCacheAdapter` (ioredis) |
| Estoque | `InMemoryStockAdapter` | `RedisStockAdapter` (**Lua DECRBY atômico**) |
| Idempotência | `InMemoryIdempotencyAdapter` | `RedisIdempotencyAdapter` (**SET NX**) |
| Fila/Worker | `InMemoryQueueAdapter` (retry/backoff) | `BullMqQueueAdapter` (BullMQ) |

### Fluxo do checkout (anti pedido/mensagem-fantasma)

```
idempotência (claim atômico)
  → reserva de estoque atômica  (falha => 409, nada persiste)
  → grava Order PENDING         (origem da verdade, ANTES de enfileirar)
  → enfileira job               (a fila é o "outbox lógico")
  → responde 202
Worker (idempotente): PENDING→PROCESSING→ (ERP ok) CONFIRMED
                                         | (esgota retries) FAILED + compensa estoque
Reconciliação: varre PENDING órfãos → reenfileira ou FAILED+compensa
```

---

## Como cada critério é atendido

### Cache (TTL, invalidação, fallback, anti-stampede)
- **Cache-aside** em `GET /products` com **TTL** (`PRODUCTS_CACHE_TTL_MS`) + **jitter** para
  espalhar expirações.
- **Single-flight**: misses concorrentes na mesma chave compartilham uma execução do loader
  (previne **cache stampede**) — testado em `cache.spec.ts`.
- **Fallback stale-while-error**: se o ERP fake falhar, serve o último valor bom.
- **Métrica** `cache_requests_total{result=hit|miss|stale}` valida ganho sem servir dado velho.

### Consistência de estoque e idempotência
- **Reserva atômica**: Redis Lua `DECRBY` condicional (prod) ou operação síncrona in-memory
  (Node single-thread). Sem TOCTOU → **sem overselling**.
- Teste de concorrência: **50 reservas simultâneas para estoque 10 ⇒ exatamente 10 OK**
  (`stock-concurrency.spec.ts`); e via HTTP/use-case, 5 checkouts p/ estoque 2 ⇒ 2 aceitos.
- **Idempotência** por header `Idempotency-Key` (Redis `SET NX` / Map). Retry e duplo clique
  retornam o mesmo `orderId` sem dupla reserva.
- Métricas `oversell_prevented_total`, `stock_reservation_total{result}`.

### Resiliência assíncrona
- `POST /checkout` responde **202** imediatamente; o ERP lento é isolado no worker.
- **Retry com backoff exponencial** (BullMQ nativo / equivalente in-memory), `WORKER_MAX_ATTEMPTS`.
- Esgotadas as tentativas: pedido `FAILED` + **compensação** (libera o estoque) — testado.
- **Reconciliação** (`POST /admin/reconcile` + `@Interval`) para pedidos `PENDING` órfãos.

### Observabilidade
- **Logs estruturados** (pino, JSON) com `correlationId` (propagado via `AsyncLocalStorage`,
  inclusive ao worker) e `orderId` quando existe.
- **Métricas** Prometheus em `/metrics`: cache hit/miss, checkout (counter+histogram),
  fila (`queue_depth`), worker (`worker_jobs_total`, `worker_duration_seconds`), ERP, oversell.
- **Traces/spans** (`TracingService`) ligando request → cache → ERP fake → fila → worker.
  Stub justificado; troca para OTel real definindo `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## Runbook / Dashboard / Alertas (Datadog ou equivalente)

### Dashboard (painéis sugeridos)
1. **Tráfego/Latência** — RPS e p50/p95/p99 por rota via histograma
   `http_request_duration_seconds{method,route,status_code}` (rota é o **padrão**, ex.
   `/orders/:orderId/status`); checkout e worker têm histogramas dedicados
   (`checkout_duration_seconds`, `worker_duration_seconds`).
2. **Cache** — `cache_requests_total` por resultado, hit ratio, offload do ERP.
3. **Checkout** — taxa de 202, conflitos (409), `checkout_duration_seconds`.
4. **Fila/Worker** — `queue_depth`, `worker_jobs_total{result}`, `worker_duration_seconds`.
5. **Estoque** — `stock_reservation_total{result}`, `oversell_prevented_total`.
6. **ERP** — `erp_calls_total{result}`, `erp_call_duration_seconds`.

### Alertas
- **hit ratio < 80%** por 10 min → revisar TTL / chave quente. _Valor derivado em PromQL/Datadog:
  `rate(cache_requests_total{result="hit"}[5m]) / rate(cache_requests_total[5m])` — não é série emitida._
- p95 `GET /products` > 200 ms por 5 min → degradação de cache/ERP.
- `queue_depth` crescente / `worker_jobs_total{result="failed"}` > 0 → backlog/ERP indisponível.
- `oversell_prevented_total` subindo rápido → pico de demanda em SKU sem estoque.

### Runbook — "pedidos travados em PENDING"
1. Ver `queue_depth` e logs do worker (`worker_jobs_total{result}`).
2. Conferir saúde do ERP (`erp_calls_total{result="error"}`, `erp_call_duration_seconds`).
3. Rodar `POST /admin/reconcile` para reenfileirar órfãos.
4. Persistindo, inspecionar a DLQ do BullMQ (jobs em `failed`).

---

## Decisões e trade-offs
- **NestJS + TS**: DI/módulos e `@nestjs/swagger` nativo (contrato fonte-da-verdade).
- **Hexagonal**: permite testar a regra de negócio sem Docker e trocar Redis↔in-memory.
- **`priceCents`** (inteiro) evita erros de ponto flutuante com dinheiro.
- **Grava pedido antes de enfileirar** + worker idempotente + reconciliação: mitiga o
  *dual-write problem* no escopo (sem outbox transacional completo).

## Simplificações (por ser desafio técnico)
- ERP é um **fake in-memory** com latência/falha simuladas (sem MySQL real). Acesso read-only
  do ERP real seria substituído por CDC/polling para um read model (ver Parte 1.A).
- Sem autenticação, pagamento, deploy ou front-end.
- Persistência de pedidos in-memory (reinício zera o estado). Em produção: Postgres/Redis.
- Single-flight de cache é por instância; cross-instância usaria lock `SET NX` (citado no código).
- Estoque é semeado do catálogo no boot (demo); em produção viria do read model sincronizado.

## Estrutura
```
src/
  domain/         order.ts product.ts stock.ts errors.ts
  application/    ports/  use-cases/  reconcile.scheduler.ts  application.module.ts
  infrastructure/ cache/ queue/ stock/ idempotency/ repo/ erp/ config/ redis.provider.ts
  interface/http/ controllers/ dto/ filters/
  observability/  logger.config.ts metrics.* tracing.service.ts correlation*.ts
test/             http.e2e.spec.ts
docs/             RESPOSTAS-CONCEITUAIS.md  DESIGN-PATTERNS.md  ARCHITECTURE-DIAGRAM.md
.specs/           planejamento spec-driven (PROJECT, STATE, spec, design, tasks)
```

## Scripts
| Script | Ação |
|---|---|
| `npm start` / `npm run start:dev` | Sobe a API |
| `npm test` / `npm run test:cov` | Testes (e cobertura) |
| `npm run build` | Compila (tsc/nest) |
| `npm run openapi` | Gera `openapi.json` |

## Variáveis de ambiente
Ver [`.env.example`](.env.example). Principais: `*_DRIVER` (memory/redis), `REDIS_URL`,
`PRODUCTS_CACHE_TTL_MS`, `WORKER_MAX_ATTEMPTS`, `WORKER_BACKOFF_MS`, `ERP_FAIL_RATE`.

---

Uso de IA documentado em [`PROMPTS.md`](PROMPTS.md).
