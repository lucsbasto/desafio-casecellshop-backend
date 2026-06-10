# Revisão de Conformidade — Código + Diagramas vs. Desafio (PDF)

> Auditoria do que foi **implementado** (`src/`) e dos **diagramas** (`docs/design/diagrams/`)
> contra os requisitos de `II. Desafio - Pleno (Backend).pdf`.
> Método: 5 subagents em paralelo (uma trilha por área) + verificação manual dos achados
> contraditórios na fonte. Data: 2026-06-09.

## Veredito geral

**Conformidade alta. Entrega aprovada.** Os 12 itens do checklist da Parte 1.B estão
atendidos, as 5 perguntas conceituais da Parte 1.A estão respondidas e completas, e os
5 diagramas são tecnicamente fiéis ao código. As lacunas encontradas são **documentais e
menores** (nomes de métricas citados em docs que não existem como séries exportadas,
contagem de testes desatualizada, e dois docs de auditoria internos defasados por um
refactor) — nenhuma compromete os requisitos do desafio.

| Bloco do PDF | Resultado |
|---|---|
| Parte 1.B — API, cache e contrato (4 itens) | ✅ 4/4 (1 nota menor) |
| Parte 1.B — Observabilidade (4 itens) | ✅ 4/4 (notas de doc) |
| Parte 1.B — Concorrência/assíncrono/entrega (4 itens) | ✅ 4/4 |
| Parte 1.A — 5 perguntas conceituais | ✅ 5/5 completas |
| Diagramas (fidelidade ao código) | ✅ 5/5 fiéis |

Testes: **26 passando em 5 suites** (`npx jest`, verificado nesta revisão).

---

## Parte 1.B — Back-end: API, cache e contrato

| # | Requisito | Status | Evidência |
|---|---|---|---|
| 1 | `GET /products` com cache + TTL | ✅ | `products.controller.ts:12` → `list-products.usecase.ts:35` cache-aside `getOrLoad(ALL_KEY, ttl, loader, {staleOnError})`; TTL em `app-config.ts:49` (`productsTtlMs=15000`) |
| 2 | `POST /checkout` → **202** com orderId/status | ✅ | `checkout.controller.ts:20` `@HttpCode(HttpStatus.ACCEPTED)`; retorna `{orderId, status: PENDING, replay}` (`checkout.dto.ts:45`) |
| 3 | `GET /orders/{orderId}/status` | ✅ | `orders.controller.ts:12` `@Get(':orderId/status')`; retorna status + histórico + tentativas (`order.dto.ts:23`); 404 via `OrderNotFoundError` |
| 4 | OpenAPI com schemas de sucesso **e erro** | ✅¹ | `swagger.ts` + `openapi.json`; `ErrorDto` (`error.dto.ts:4`) em 400/404/409; filtro global emite a mesma forma (`domain-exception.filter.ts:77`) |

**Qualidade do cache (reflete a Pergunta 2 conceitual):**

- **TTL** configurável e funcional — `productsTtlMs` (`app-config.ts:49`). *Corrige um falso
  positivo da auditoria automática:* não há bug de `TTL=NaN`. O `ttl()` em
  `list-products.usecase.ts:31-33` retorna o TTL puro; o jitter foi **movido para o adapter**
  (`cache-jitter.ts`), modelo proporcional via `stampedeJitterRatio=0.2` (`app-config.ts:52`).
  Verificado na fonte.
- **Anti-stampede (single-flight)** — coalescing de misses concorrentes via `Map inflight`
  (`in-memory-cache.adapter.ts:56`, `redis-cache.adapter.ts:53`). Testado: `cache.spec.ts:22`
  (20 chamadas → loader roda 1×).
- **Jitter no TTL** — `cache-jitter.ts:21`, só estende a janela. Testado: `cache.spec.ts:66`.
- **Fallback (stale-on-error)** — `lastKnown` + `staleOnError` servem valor velho se o ERP
  falhar (`*-cache.adapter.ts`); usado em `list-products.usecase.ts:41,53`. Testado:
  `cache.spec.ts:47`.
- ⚠️ **Invalidação ativa ausente** — ninguém chama `cache.del('products:*')` após mudança de
  estoque/preço; a invalidação depende só do TTL. Aceitável para o escopo (ERP é fake e read-only),
  mas vale registrar como limitação consciente.

¹ **Nota menor:** respostas `5xx` não estão documentadas explicitamente no OpenAPI (o filtro
retorna 500 `INTERNAL_ERROR` em runtime). Um `@ApiInternalServerErrorResponse({ type: ErrorDto })`
fecharia a lacuna. Os 4xx já estão cobertos com schema.

---

## Parte 1.B — Observabilidade

| # | Requisito | Status | Evidência |
|---|---|---|---|
| 1 | Logs estruturados com correlationId + orderId | ✅ | `logger.config.ts:25` injeta `correlationId`; `correlation.middleware.ts:15` monta em `req.id`; worker reentra contexto via `runWithCorrelation({correlationId, orderId})` (`checkout.worker.ts:34`) sobre `AsyncLocalStorage` (`correlation.ts:12`) |
| 2 | Métricas (cache hit/miss + checkout/fila/worker) | ✅ | Registry Prometheus em `metrics.service.ts`: `cache_requests_total{result=hit\|miss\|stale}` (:26), `checkout_*`, `queue_depth`, `worker_jobs_total`, `erp_*`, `oversell_prevented_total`. Hit/miss incrementado no caminho real: `list-products.usecase.ts:44,55`. `/metrics` Prometheus em `metrics.controller.ts:11` |
| 3 | Bônus: trace/span ligando request→cache→repo→worker | ✅ | `tracing.service.ts` (stub OTel-compatível, justificado); spans `cache.get`/`erp.fetch` (`list-products.usecase.ts:36,40`), `stock.reserve`/`queue.enqueue` (`checkout.usecase.ts:107,143`), `worker.process`/`erp.invoice` (`checkout.worker.ts:39,128`) |
| 4 | README com dashboard/alerta/runbook | ✅ | `README.md:152-173`: 6 painéis, 4 alertas com threshold, runbook "pedidos travados em PENDING" |

**Lacunas documentais (não bloqueiam, mas vale corrigir):**

- ⚠️ O dashboard do README cita a métrica **`http_request_duration`** (`README.md:155`) que
  **não existe** em `metrics.service.ts` (confirmado por grep). Não há histograma de latência
  HTTP por rota — só `checkout_duration_seconds`/`worker_duration_seconds`. Ou criar a série,
  ou ajustar o README.
- ⚠️ Alertas/docs citam **`cache_hit_ratio`** (`README.md:163`), e
  `RESPOSTAS-CONCEITUAIS.md:166` cita **`cache_served_age_seconds`** e
  **`cache_staleness_ratio`** — nenhuma é série exportada (seriam derivadas em PromQL/Datadog a
  partir de `cache_requests_total`). Vale uma nota deixando claro que são valores **derivados**,
  não métricas emitidas.
- ⚠️ SLI/SLO não aparecem com terminologia explícita no README (há thresholds que funcionam como
  SLO implícito: hit-ratio ≥80%, p95 ≤200ms). A formalização SLI/SLO existe em
  `RESPOSTAS-CONCEITUAIS.md` (Pergunta 3).
- Viés conhecido (já comentado no próprio código): misses coalescidos pelo single-flight contam
  como `hit` (`in-memory-cache.adapter.ts:58`), inflando levemente o hit-ratio.

---

## Parte 1.B — Concorrência, assíncrono e entrega

| # | Requisito | Status | Evidência |
|---|---|---|---|
| 1 | Checkout evita overselling (atômico) | ✅ | **Redis:** `RESERVE_LUA` GET+check+DECRBY atômico server-side (`redis-stock.adapter.ts:13`). **In-memory:** seção crítica síncrona sem `await` (`in-memory-stock.adapter.ts:21`). Regra pura em `stock.ts:13`. Técnica: *atomic conditional update* |
| 2 | Idempotência (duplo clique + retry) + worker→ERP | ✅ | `idempotency.remember(key)` antes de efeitos colaterais (`checkout.usecase.ts:88`); `SET NX PX`+`GET` em Lua (`redis-idempotency.adapter.ts:12`); worker idempotente com guard anti dupla-fatura (`checkout.worker.ts:51-69`); ERP fake (`fake-erp.client.ts:37`) |
| 3 | Testes: regra de negócio + cache/concorrência | ✅ | Corrida real: `stock-concurrency.spec.ts:8` (50 reservas → 10 ok/40 falham/saldo 0); `checkout-flow.spec.ts:103` (5 checkouts → 2 ok/3 falham); single-flight `cache.spec.ts:22` |

**Resiliência (Perguntas 4 e 5 conceituais, exercitadas no código):**

- **Ordem correta** — grava pedido `PENDING` (fonte da verdade, `checkout.usecase.ts:140`)
  **antes** de `enqueue` (`:143`). Evita *mensagem fantasma*. Comentado como "outbox lógico".
- **Anti pedido-fantasma** — reconciliação (`reconcile.usecase.ts:32`) varre PENDING órfãos a
  cada 15s (`reconcile.scheduler.ts:20`): recentes → re-enqueue; muito antigos → FAILED + libera
  estoque. Cobre o caso "pedido salvo mas enqueue falhou".
- **Retry com backoff exponencial** — `backoff.strategy.ts:15`, compartilhado entre in-memory
  (`in-memory-queue.adapter.ts:52`) e BullMQ (`bullmq-queue.adapter.ts:51`, `removeOnFail:false`
  = DLQ inspecionável). Esgotamento → FAILED + compensação (`checkout.worker.ts:100`).
- **Máquina de estados** — PENDING/PROCESSING/CONFIRMED/FAILED com transições validadas e
  `PROCESSING ↛ PENDING` proibido (`order.ts:39`).

**Notas não-bloqueantes (todas comentadas no código):** (a) `RedisStockAdapter.release` sem teto
superior; (b) guard de dupla-fatura é heurístico (compara `attempt` vs `attempts`), não
transacional; (c) não há outbox transacional verdadeiro nem reconciliação ativa contra o ERP — a
reconciliação por idade cobre pragmaticamente. Adequado ao escopo.

---

## Parte 1.A — Perguntas conceituais

Todas em `docs/RESPOSTAS-CONCEITUAIS.md`, linkado pelo README.

| # | Pergunta | Status | Onde |
|---|---|---|---|
| P1 | Diagnóstico dos 3 problemas, impacto, ≥2 soluções, arquitetura 30–90d | ✅ Completa | §Pergunta 1 (L11–95) — tabela custo/complexidade/latência/consistência/esforço + diagrama alvo |
| P2 | Cache: camadas, TTL, invalidação, cache-aside/refresh, fallback, anti-stampede, métricas | ✅ Completa | §Pergunta 2 (L99–139) |
| P3 | Observabilidade: logs/campos, métricas por tipo, traces, SLI/SLO/alerta/dashboard | ✅ Completa | §Pergunta 3 (L143–198) |
| P4 | Concorrência: TOCTOU, atomic vs lock vs reserva vs distributed lock, idempotência, teste | ✅ Completa | §Pergunta 4 (L202–235) |
| P5 | Mensageria: antes/depois de gravar, pedido/mensagem fantasma, retry, status, OpenAPI, IA | ✅ Completa | §Pergunta 5 (L239–311) |

**Itens de entrega:** README com decisões/trade-offs/limitações/como-rodar/prompts ✅ ·
`openapi.json` ✅ · `PROMPTS.md` ✅ · `.env.example` ✅.

---

## Diagramas — fidelidade ao código

Os 5 diagramas (`docs/design/diagrams/*.mmd`) foram confrontados nó a nó com `src/`. **Nenhum
erro factual** — só simplificações didáticas já documentadas.

| Diagrama | Status | Nota |
|---|---|---|
| `01-hexagonal.mmd` | ✅ fiel | 6 ports/adapters existem; nó `REPOSITORY_PORT` = 2 tokens reais (`ORDER_REPO_PORT`+`PRODUCT_REPO_PORT`) — simplificação |
| `02-checkout-sequence.mmd` | ✅ fiel | Ordem bate com `checkout.usecase.ts run()`; ramo 409 `DuplicateRequestError` (chave vista sem pedido) colapsado no replay 202 — omissão cosmética |
| `03-order-state-machine.mmd` | ✅ exato | 1:1 com `order.ts:39-46` (`ALLOWED`) |
| `04-resilience.mmd` | ✅ fiel | Lua CAS, outbox lógico, `@Interval 15s`, dois cortes de idade, backoff, DLQ — tudo confere |
| `05-cache-aside.mmd` | ✅ fiel | hit/miss, single-flight, TTL+jitter, stale-on-error batem |

**Cobertura de temas:** todos os temas exigidos têm diagrama, exceto **observabilidade**
(aparece só implicitamente). Candidato opcional: um `sequenceDiagram` da propagação de
`correlationId` HTTP→fila→worker — já sugerido em `CROSS-REFERENCE.md`.

---

## Achados acionáveis (priorizados)

Todos menores; nenhum bloqueia a entrega. Em ordem de valor/custo:

1. **README — métricas inexistentes.** Remover/ajustar `http_request_duration` e marcar
   `cache_hit_ratio`/`cache_served_age_seconds`/`cache_staleness_ratio` como **derivadas** em
   PromQL (não emitidas). Alternativa: criar as séries em `metrics.service.ts`.
2. **README — contagem de testes.** Diz "23 testes"; o real é **26** (`npx jest`, 5 suites).
   Atualizar.
3. **Docs de auditoria.** `ACCURACY-CHECK.md` e `CITATIONS-AUDIT.md` foram atualizados: o
   TTL-jitter saiu de `list-products.usecase.ts` e migrou para `cache-jitter.ts` (`createJitter()`),
   virando proporcional (`stampedeJitterRatio`, default `DEFAULT_JITTER_RATIO`). Referência agora
   por símbolo (`createJitter()` + `app-config.ts → stampedeJitterRatio`).
4. **OpenAPI — 5xx.** Adicionar `@ApiInternalServerErrorResponse({ type: ErrorDto })` para
   cobertura completa de erro.
5. **Invalidação de cache.** Registrar como limitação consciente que a invalidação é só por TTL
   (sem `del()` ativo) — coerente com ERP fake read-only.
6. **(Opcional) Diagrama de observabilidade** — propagação de correlationId; e anotar o ramo 409
   no diagrama 02.

> Nota de método: a auditoria automática da trilha de cache reportou um "bug crítico de TTL=NaN"
> em `list-products.usecase.ts`. **Refutado por verificação na fonte** — o agente leu uma versão
> obsoleta do arquivo. O código atual está correto.
