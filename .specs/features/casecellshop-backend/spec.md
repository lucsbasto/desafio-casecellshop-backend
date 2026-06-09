# SPEC — CaseCellShop Backend (Parte 1.B)

## Objetivo
Serviço backend que expõe catálogo de produtos com cache, inicia checkout assíncrono e
permite consultar o status do pedido, com observabilidade e consistência de estoque.

## Requisitos funcionais

### Catálogo + Cache
- **FR-1** `GET /products` retorna lista de produtos (id, nome, preço, disponibilidade).
- **FR-2** `GET /products/:id` retorna um produto.
- **FR-3** Respostas de catálogo usam **cache-aside** com **TTL**; o "ERP" é um repositório
  fake com latência simulada (origem da verdade de produto/preço).
- **FR-4** Cache expõe **hit/miss** observável; protege contra **stampede** (single-flight/lock)
  e tem **fallback** (serve stale em falha do ERP — stale-while-error).
- **FR-5** Invalidação: TTL + invalidação ativa por evento (ex.: mudança de estoque invalida a
  entrada de disponibilidade do produto).

### Checkout assíncrono
- **FR-6** `POST /checkout` recebe `{ items:[{productId, quantity}] }` + header
  `Idempotency-Key`. Valida e **reserva estoque atomicamente**; cria pedido `PENDING`;
  enfileira job; responde **202 Accepted** com `{ orderId, status }`.
- **FR-7** **Idempotência**: mesma `Idempotency-Key` ⇒ mesmo `orderId`, sem dupla reserva
  (tolera retry e duplo clique).
- **FR-8** **Sem overselling**: reserva condicional atômica; se estoque insuficiente ⇒ 409.
- **FR-9** **Worker** consome a fila e simula faturamento no ERP (latência + falhas aleatórias),
  com **retry** (backoff) e transição de status. Em sucesso: `CONFIRMED`. Esgotadas as
  tentativas: `FAILED` + **compensação** (libera reserva de estoque).
- **FR-10** `GET /orders/:orderId/status` retorna status atual e histórico de transições.
- **FR-11** **Reconciliação** simples: rotina/endpoint que detecta pedidos `PENDING` órfãos
  (sem job/expirados) e os reconcilia (re-enfileira ou marca `FAILED`+compensa).

### Contrato
- **FR-12** OpenAPI disponível em `/docs` (Swagger UI) e exportável para `openapi.json`, com
  **schemas de sucesso e erro** (incluindo 400/404/409/422).

## Requisitos de observabilidade
- **OBS-1** Logs estruturados (JSON) com `correlationId`/`requestId` em toda request e
  `orderId` quando existir. Propagação ao worker.
- **OBS-2** Métricas Prometheus em `/metrics`:
  - counter `cache_requests_total{result=hit|miss}`
  - counter `checkout_requests_total{outcome}` / histogram `checkout_duration_seconds`
  - gauge `queue_depth` / counter `worker_jobs_total{result}` / histogram `worker_duration_seconds`
  - counter `erp_calls_total{result}` / histogram `erp_call_duration_seconds`
  - counter `oversell_prevented_total`
- **OBS-3** Traces/spans (OpenTelemetry) ligando request → cache → repo fake → fila → worker.
  Stub justificado aceitável (console/OTLP exporter opcional).
- **OBS-4** README com exemplo de **dashboard**, **alerta** e **runbook** (Datadog/equivalente).

## Requisitos não-funcionais
- **NFR-1** `npm ci && npm run build && npm test` verdes **sem Docker** (adapters in-memory).
- **NFR-2** `docker compose up` sobe app + Redis (runtime de produção) — caminho real.
- **NFR-3** Código organizado em camadas (domain / application / infrastructure / interface).
- **NFR-4** Sem segredos no repo; `.env.example` documentado.

## Critérios de aceite (alto nível)
- AC-1: GET /products responde com cache (2ª chamada = hit; logs/métrica comprovam).
- AC-2: POST /checkout retorna 202 + orderId; status evolui PENDING→CONFIRMED|FAILED.
- AC-3: Teste de concorrência: N requisições simultâneas para item com estoque M (<N) ⇒
  no máximo M reservas; resto 409; estoque final ≥ 0; `oversell_prevented_total` > 0.
- AC-4: Teste de idempotência: mesma key repetida ⇒ 1 pedido, 1 reserva.
- AC-5: OpenAPI válido com schemas de erro; `/docs` e `openapi.json`.
- AC-6: `/metrics` expõe cache hit/miss e checkout/worker; logs com correlationId+orderId.

## Gray areas resolvidos (ver STATE D5–D7)
- Reserva atômica (D5), idempotência por header (D6), ordem grava-antes-de-enfileirar +
  reconciliação (D7).
