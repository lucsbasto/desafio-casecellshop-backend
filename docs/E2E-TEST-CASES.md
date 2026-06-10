# Casos de Teste E2E — CaseCellShop (Backend Pleno)

> **Fonte:** derivado exclusivamente do documento `II. Desafio - Pleno (Backend).pdf`
> (não a partir do código). O objetivo é validar, em caixa-preta, que a entrega
> atende a **todos** os critérios de avaliação e os itens do checklist da Parte 1.B.
>
> **Tipo:** testes end-to-end (E2E) sobre a API HTTP + efeitos observáveis
> (cache, fila/worker, métricas, logs, status de pedido).
>
> **Convenções:**
> - `BASE_URL` = `http://localhost:3000` (Docker Compose / `npm start`).
> - IDs no formato `TC-<área>-NN`.
> - Cada caso tem: **Objetivo**, **Pré-condições**, **Passos**, **Resultado esperado**.
> - Prioridade: **P0** (bloqueante / critério principal), **P1** (importante), **P2** (bônus/edge).

---

## Rastreabilidade — Requisito → Casos de teste

| Requisito do PDF | Casos cobrindo |
|---|---|
| `GET /products` retorna produtos e usa cache com TTL | TC-PROD-01..09 |
| Cache: TTL, invalidação, fallback, anti-stampede, anti-stale | TC-CACHE-01..08 |
| `POST /checkout` → 202 Accepted com orderId/status | TC-CHK-01..06 |
| `GET /orders/{orderId}/status` acompanha processamento | TC-ORD-01..06 |
| OpenAPI / contrato com schemas de sucesso e erro | TC-CONTRACT-01..07 |
| Consistência de estoque / anti-overselling | TC-STOCK-01..08 |
| Idempotência (retry, duplo clique, reprocessamento) | TC-IDEM-01..07 |
| Resiliência assíncrona: retry, status, reconciliação, worker→ERP | TC-RESIL-01..09 |
| Observabilidade: logs estruturados, métricas, traces | TC-OBS-01..10 |

---

## 1. Catálogo de Produtos — `GET /products` (TC-PROD)

### TC-PROD-01 — Listar produtos com sucesso `[P0]`
- **Objetivo:** a vitrine retorna o catálogo.
- **Pré-condições:** serviço no ar; catálogo seed carregado.
- **Passos:**
  1. `GET /products`.
- **Resultado esperado:**
  - HTTP `200`.
  - Corpo é uma lista (ou objeto paginado) com ≥ 1 produto.
  - Cada item contém ao menos: `id`, `name`, `price`, `availableStock` (ou equivalente de disponibilidade).
  - `Content-Type: application/json`.

### TC-PROD-02 — Buscar produto único por ID `[P1]`
- **Objetivo:** consulta granular (se `GET /products/{id}` existir).
- **Passos:** `GET /products/{id}` de um produto válido.
- **Resultado esperado:** `200` com o produto correspondente ao `id`.

### TC-PROD-03 — Produto inexistente `[P1]`
- **Passos:** `GET /products/{id}` com ID inexistente.
- **Resultado esperado:** `404` com corpo de erro no schema padrão (ver TC-CONTRACT-05).

### TC-PROD-04 — Primeira leitura é cache MISS `[P0]`
- **Objetivo:** comprovar leitura cache-aside no ERP simulado.
- **Pré-condições:** cache vazio (serviço recém-iniciado ou chave expirada).
- **Passos:**
  1. `GET /products`.
  2. Consultar `/metrics`.
- **Resultado esperado:**
  - `200`.
  - Métrica de `cache_miss` (products) incrementa em 1.
  - Latência ≥ latência do ERP simulado (caminho "lento").

### TC-PROD-05 — Segunda leitura é cache HIT `[P0]`
- **Passos:**
  1. `GET /products` (popula cache).
  2. `GET /products` novamente, dentro do TTL.
  3. Consultar `/metrics`.
- **Resultado esperado:**
  - Ambas `200` com **mesmo payload**.
  - Métrica `cache_hit` incrementa na 2ª chamada.
  - 2ª resposta com latência sensivelmente menor que a 1ª.

### TC-PROD-06 — Expiração por TTL gera novo MISS `[P0]`
- **Pré-condições:** TTL do catálogo conhecido (ex.: `PRODUCTS_CACHE_TTL_MS`).
- **Passos:**
  1. `GET /products` (MISS → popula).
  2. `GET /products` (HIT).
  3. Aguardar `TTL + folga`.
  4. `GET /products`.
- **Resultado esperado:** a chamada do passo 4 volta a ser `cache_miss` (reconsulta o ERP).

### TC-PROD-07 — Cache reflete atualização após expirar (anti-stale) `[P0]`
- **Objetivo:** prevenir dados obsoletos (critério "prevenção de dados obsoletos").
- **Pré-condições:** possível alterar preço/estoque na fonte simulada (ex.: via checkout que decrementa estoque, ou endpoint/seed).
- **Passos:**
  1. `GET /products` e registrar `availableStock` do produto X.
  2. Reduzir estoque de X na fonte (ex.: concluir um checkout de X).
  3. Aguardar expirar o TTL.
  4. `GET /products`.
- **Resultado esperado:** após o TTL, o estoque retornado reflete o novo valor (não serve indefinidamente o valor velho).

### TC-PROD-08 — Disponibilidade nunca negativa na vitrine `[P1]`
- **Passos:** após múltiplos checkouts que esgotam o estoque de X, `GET /products`.
- **Resultado esperado:** `availableStock` de X é `0` (nunca negativo).

### TC-PROD-09 — Catálogo sob carga concorrente é consistente `[P1]`
- **Passos:** disparar 50 `GET /products` em paralelo logo após o boot.
- **Resultado esperado:** todas `200`; payloads consistentes; sem `5xx`; ver TC-CACHE-05 (stampede).

---

## 2. Comportamento de Cache (TC-CACHE)

### TC-CACHE-01 — TTL respeitado dentro da janela `[P0]`
- **Passos:** 5 `GET /products` em sequência rápida (< TTL).
- **Resultado esperado:** 1 MISS + 4 HITs nas métricas.

### TC-CACHE-02 — Invalidação após mutação de estoque `[P0]`
- **Objetivo:** validar invalidação/refresh (não só TTL).
- **Pré-condições:** o sistema invalida ou atualiza a entrada de cache quando o estoque muda (se a estratégia for invalidação ativa; caso seja apenas TTL, marcar como N/A e validar via TC-PROD-07).
- **Passos:**
  1. `GET /products` (popula).
  2. Concluir checkout que decrementa estoque de X.
  3. `GET /products` imediatamente.
- **Resultado esperado:** se houver invalidação ativa, o estoque novo aparece **antes** do TTL expirar. Caso contrário, documentar como TTL-only.

### TC-CACHE-03 — Fallback quando a fonte (ERP simulado) falha `[P0]`
- **Objetivo:** critério "fallback".
- **Pré-condições:** modo de falha do ERP ativável (ex.: `ERP_FAIL_RATE` alto, ou cache já populado).
- **Passos:**
  1. `GET /products` (popula cache).
  2. Forçar a fonte a falhar.
  3. `GET /products`.
- **Resultado esperado:** retorna `200` servindo do cache (stale-on-error) **ou** erro `5xx` controlado com corpo no schema de erro — comportamento documentado e coerente, sem stacktrace cru.

### TC-CACHE-04 — Métrica de hit ratio exposta `[P1]`
- **Passos:** após N requests, consultar `/metrics`.
- **Resultado esperado:** counters `cache_hit` e `cache_miss` separados por recurso permitem calcular hit ratio.

### TC-CACHE-05 — Cache stampede sob concorrência `[P1]`
- **Objetivo:** critério "evitar cache stampede".
- **Pré-condições:** cache vazio.
- **Passos:** disparar 100 `GET /products` simultâneos no instante do boot/expiração.
- **Resultado esperado:** o número de chamadas reais à fonte simulada é pequeno (idealmente 1, via single-flight/lock), **não** 100. Verificável por métrica/contador de chamadas ao ERP ou por log.

### TC-CACHE-06 — Chaveamento de cache por recurso `[P2]`
- **Passos:** popular cache de `/products`; consultar produto específico.
- **Resultado esperado:** as chaves não colidem; invalidar uma não derruba indevidamente outra (se aplicável).

### TC-CACHE-07 — Driver de cache configurável (memória vs Redis) `[P1]`
- **Objetivo:** o desafio permite memória ou Redis.
- **Passos:** subir com `CACHE_DRIVER=redis` (Docker Compose) e repetir TC-PROD-04/05.
- **Resultado esperado:** comportamento de hit/miss idêntico; chaves visíveis no Redis (`redis-cli KEYS *`).

### TC-CACHE-08 — Cache sobrevive entre requisições, não entre TTL `[P1]`
- **Passos:** HIT confirmado; aguardar TTL; novo MISS (combina TC-PROD-06).
- **Resultado esperado:** consistente com a política declarada no README.

---

## 3. Checkout Assíncrono — `POST /checkout` (TC-CHK)

### TC-CHK-01 — Checkout aceito retorna 202 `[P0]`
- **Objetivo:** contrato assíncrono.
- **Pré-condições:** produto X com estoque disponível.
- **Passos:** `POST /checkout` com body válido (ex.: `{ items: [{ productId: X, quantity: 1 }] }`) e header de idempotência.
- **Resultado esperado:**
  - HTTP `202 Accepted`.
  - Corpo contém `orderId` e `status` (ex.: `PENDING`/`PROCESSING`).
  - `orderId` é único e rastreável.

### TC-CHK-02 — Validação de payload inválido `[P0]`
- **Passos:** `POST /checkout` com body inválido (sem `items`, `quantity <= 0`, `productId` ausente).
- **Resultado esperado:** `400` (ou `422`) com erro no schema padrão; **nenhum** pedido criado; estoque inalterado.

### TC-CHK-03 — Checkout de produto inexistente `[P1]`
- **Passos:** `POST /checkout` com `productId` inexistente.
- **Resultado esperado:** `400`/`404` com erro claro; nenhum pedido/efeito colateral.

### TC-CHK-04 — Checkout sem estoque é rejeitado `[P0]`
- **Pré-condições:** produto X com estoque `0`.
- **Passos:** `POST /checkout` de X.
- **Resultado esperado:** rejeição coerente (ex.: `409 Conflict` / `422`) **ou** pedido criado e finalizado como `FAILED/REJECTED` por falta de estoque — comportamento documentado. Estoque nunca fica negativo.

### TC-CHK-05 — Resposta não bloqueia até faturar `[P0]`
- **Objetivo:** o `202` retorna rápido, sem esperar o worker/ERP.
- **Passos:** medir latência do `POST /checkout`.
- **Resultado esperado:** resposta retorna em tempo baixo (não espera o processamento do ERP simulado, que é lento/falível).

### TC-CHK-06 — Reserva de estoque no aceite `[P1]`
- **Objetivo:** validar reserva/decremento atômico na admissão.
- **Passos:**
  1. Ler `availableStock` de X.
  2. `POST /checkout` de 1 unidade de X (aceito com `202`).
  3. `GET /products`.
- **Resultado esperado:** a disponibilidade de X reflete a reserva (decrementada ou marcada como reservada), evitando que outro pedido conte com a mesma unidade.

---

## 4. Status do Pedido — `GET /orders/{orderId}/status` (TC-ORD)

### TC-ORD-01 — Consultar status de pedido recém-criado `[P0]`
- **Passos:**
  1. `POST /checkout` → obter `orderId`.
  2. `GET /orders/{orderId}/status` imediatamente.
- **Resultado esperado:** `200` com `status` em estado inicial (`PENDING`/`PROCESSING`).

### TC-ORD-02 — Status evolui até estado terminal `[P0]`
- **Objetivo:** rastreabilidade do processamento assíncrono.
- **Passos:**
  1. Criar checkout.
  2. Fazer polling de `GET /orders/{orderId}/status` até estado terminal (timeout razoável, ex.: 30s).
- **Resultado esperado:** o status transita para um estado terminal válido (`CONFIRMED`/`COMPLETED` ou `FAILED`), sem ficar preso em `PENDING` indefinidamente.

### TC-ORD-03 — Pedido inexistente `[P0]`
- **Passos:** `GET /orders/{orderId}/status` com `orderId` aleatório/inexistente.
- **Resultado esperado:** `404` com erro no schema padrão.

### TC-ORD-04 — Estados são válidos (máquina de estados) `[P1]`
- **Passos:** observar transições ao longo do polling.
- **Resultado esperado:** apenas transições válidas (ex.: `PENDING → PROCESSING → CONFIRMED|FAILED`); nunca volta de terminal para inicial.

### TC-ORD-05 — Pedido falho expõe motivo `[P1]`
- **Pré-condições:** forçar falha do ERP simulado (`ERP_FAIL_RATE=1`).
- **Passos:** criar checkout; aguardar terminal.
- **Resultado esperado:** status `FAILED` com motivo/erro legível; estoque reservado é **devolvido** (ver TC-RESIL-06).

### TC-ORD-06 — Consulta de status não altera o pedido `[P1]`
- **Objetivo:** GET é idempotente/seguro.
- **Passos:** consultar o status 10x.
- **Resultado esperado:** mesmo resultado; nenhuma mudança de estado provocada pela leitura.

---

## 5. Contrato de API / OpenAPI (TC-CONTRACT)

### TC-CONTRACT-01 — Documento OpenAPI disponível `[P0]`
- **Passos:** `GET /docs` (Swagger UI) e/ou `GET /docs-json` (ou `/openapi.json`).
- **Resultado esperado:** `200`; documento OpenAPI válido descrevendo `/products`, `/checkout`, `/orders/{id}/status`.

### TC-CONTRACT-02 — Schemas de sucesso documentados `[P0]`
- **Resultado esperado:** OpenAPI define schemas de resposta `200`/`202` para cada rota.

### TC-CONTRACT-03 — Schemas de erro documentados `[P0]`
- **Resultado esperado:** OpenAPI define schema de erro (ex.: `4xx`/`5xx`) com formato consistente (`code`, `message`, `correlationId` quando aplicável).

### TC-CONTRACT-04 — Resposta real adere ao schema de sucesso `[P0]`
- **Passos:** validar payloads reais de `/products` e `/checkout` contra os schemas do OpenAPI.
- **Resultado esperado:** sem violações de schema (campos/typing corretos).

### TC-CONTRACT-05 — Resposta de erro adere ao schema `[P0]`
- **Passos:** provocar `404`/`400` e comparar com o schema de erro.
- **Resultado esperado:** corpo de erro estruturado e consistente entre rotas; sem vazar stacktrace.

### TC-CONTRACT-06 — Códigos HTTP corretos por cenário `[P1]`
- **Resultado esperado:** `200` leitura, `202` checkout aceito, `400/422` validação, `404` não encontrado, `409/422` conflito de estoque, `5xx` falha de infra — coerentes e documentados.

### TC-CONTRACT-07 — Header de idempotência documentado `[P1]`
- **Resultado esperado:** o OpenAPI descreve o header de idempotência do `POST /checkout` (ex.: `Idempotency-Key`) e seu comportamento.

---

## 6. Consistência de Estoque / Anti-Overselling (TC-STOCK)

### TC-STOCK-01 — Não vende além do estoque (concorrência real) `[P0]`
- **Objetivo:** critério central — evitar overselling.
- **Pré-condições:** produto X com estoque exatamente `N` (ex.: `N=5`).
- **Passos:** disparar `N + K` checkouts concorrentes de 1 unidade de X (ex.: 20 requisições, cada uma com chave de idempotência distinta).
- **Resultado esperado:**
  - No máximo `N` pedidos chegam a estado de sucesso/reserva confirmada.
  - Os demais são rejeitados ou terminam `FAILED` por falta de estoque.
  - Estoque final de X = `0`, **nunca negativo**.

### TC-STOCK-02 — Soma de unidades vendidas = estoque inicial `[P0]`
- **Passos:** após TC-STOCK-01, somar unidades confirmadas.
- **Resultado esperado:** total confirmado ≤ `N`; reconcilia com o estoque inicial.

### TC-STOCK-03 — Decremento atômico sob duplo pedido simultâneo `[P0]`
- **Passos:** 2 checkouts simultâneos da última unidade de X.
- **Resultado esperado:** exatamente 1 sucede; o outro é negado. Sem race condition (nenhum cenário onde ambos sucedem).

### TC-STOCK-04 — Quantidade > estoque em um único pedido `[P1]`
- **Passos:** estoque `3`, `POST /checkout` com `quantity: 5`.
- **Resultado esperado:** rejeitado; estoque inalterado.

### TC-STOCK-05 — Pedido multi-item parcialmente indisponível `[P1]`
- **Pré-condições:** item A disponível, item B esgotado.
- **Passos:** `POST /checkout` com A e B.
- **Resultado esperado:** comportamento atômico documentado — ou tudo-ou-nada (rejeita e não reserva A), ou política clara; estoque de A **não** fica reservado preso se o pedido falha.

### TC-STOCK-06 — Devolução de estoque ao falhar no ERP `[P0]`
- **Pré-condições:** `ERP_FAIL_RATE=1` (worker sempre falha após esgotar retries).
- **Passos:**
  1. Estoque de X = 1; `POST /checkout` (reserva).
  2. Aguardar pedido virar `FAILED`.
  3. `GET /products`.
- **Resultado esperado:** estoque de X volta a `1` (reserva liberada) — reconciliação simples.

### TC-STOCK-07 — Estoque consistente entre cache e fonte `[P1]`
- **Passos:** comparar `availableStock` da vitrine (pós-TTL) com o decremento real após vendas.
- **Resultado esperado:** convergem após expirar o cache.

### TC-STOCK-08 — Driver de estoque (memória vs Redis) coerente `[P1]`
- **Passos:** rodar TC-STOCK-01 com `STOCK_DRIVER=redis`.
- **Resultado esperado:** garantia anti-overselling preservada com decremento atômico no Redis.

---

## 7. Idempotência (TC-IDEM)

### TC-IDEM-01 — Duplo clique (mesma Idempotency-Key) cria 1 pedido `[P0]`
- **Objetivo:** tolerar duplo clique.
- **Passos:** enviar 2x o **mesmo** `POST /checkout` com a **mesma** `Idempotency-Key`, em sequência.
- **Resultado esperado:**
  - Ambas respondem `202` (a 2ª pode ser `200`/`202` "replay").
  - Retornam o **mesmo** `orderId`.
  - Apenas **1** pedido existe; estoque decrementado **1 vez**.

### TC-IDEM-02 — Retry concorrente com mesma chave `[P0]`
- **Passos:** disparar 10 requisições **simultâneas** com a mesma `Idempotency-Key`.
- **Resultado esperado:** exatamente 1 pedido criado; todas retornam o mesmo `orderId`; 1 único decremento de estoque.

### TC-IDEM-03 — Chaves diferentes criam pedidos diferentes `[P0]`
- **Passos:** 2 checkouts iguais no conteúdo, mas com `Idempotency-Key` distintas.
- **Resultado esperado:** 2 pedidos distintos; 2 decrementos (se houver estoque).

### TC-IDEM-04 — Ausência de Idempotency-Key `[P1]`
- **Passos:** `POST /checkout` sem o header.
- **Resultado esperado:** comportamento documentado — ou `400` exigindo a chave, ou gera chave/pedido novo a cada chamada (sem proteção). Consistente com README/OpenAPI.

### TC-IDEM-05 — Replay após pedido concluído `[P1]`
- **Passos:** reenviar a mesma chave **depois** que o pedido virou terminal.
- **Resultado esperado:** retorna o pedido existente (mesmo `orderId`/status), **não** cria novo nem re-decrementa estoque.

### TC-IDEM-06 — Mesma chave com payload diferente `[P2]`
- **Passos:** reusar `Idempotency-Key` com `items` diferentes.
- **Resultado esperado:** comportamento defensivo documentado (ex.: `409`/`422` de conflito de idempotência, ou retorna o pedido original). Não cria efeito colateral inconsistente.

### TC-IDEM-07 — Idempotência no reprocessamento do worker `[P1]`
- **Objetivo:** worker não fatura 2x.
- **Passos:** forçar reprocessamento da mesma mensagem (retry do worker).
- **Resultado esperado:** o "envio ao ERP" simulado não duplica o faturamento; status final único.

---

## 8. Resiliência Assíncrona / Fila / Worker (TC-RESIL)

### TC-RESIL-01 — Mensagem é enfileirada após aceitar o pedido `[P0]`
- **Objetivo:** evitar "mensagem fantasma" / "pedido fantasma".
- **Passos:** `POST /checkout`; inspecionar fila (BullMQ/Redis) e store de pedidos.
- **Resultado esperado:** existe 1 pedido **e** 1 job correspondente; não há job sem pedido nem pedido sem processamento.

### TC-RESIL-02 — Worker processa e conclui o pedido `[P0]`
- **Pré-condições:** `ERP_FAIL_RATE=0`.
- **Passos:** criar checkout; aguardar.
- **Resultado esperado:** status → `CONFIRMED/COMPLETED`; métrica de jobs processados incrementa.

### TC-RESIL-03 — Retry em falha transitória do ERP `[P0]`
- **Pré-condições:** `ERP_FAIL_RATE` intermediário (ex.: `0.3`), `WORKER_MAX_ATTEMPTS=3`.
- **Passos:** criar vários checkouts; observar logs/métricas de retry.
- **Resultado esperado:** jobs que falham são re-tentados até `WORKER_MAX_ATTEMPTS`; parte conclui após retry; backoff aplicado (`WORKER_BACKOFF_MS`).

### TC-RESIL-04 — Esgotar retries leva a estado FAILED `[P0]`
- **Pré-condições:** `ERP_FAIL_RATE=1`.
- **Passos:** criar checkout; aguardar esgotar tentativas.
- **Resultado esperado:** após `WORKER_MAX_ATTEMPTS`, pedido → `FAILED`; (bônus) job vai para DLQ/failed set, não fica em loop infinito.

### TC-RESIL-05 — Backoff entre tentativas `[P1]`
- **Passos:** medir timestamps das tentativas nos logs.
- **Resultado esperado:** intervalo entre retries respeita o backoff configurado.

### TC-RESIL-06 — Reconciliação: estoque liberado em falha definitiva `[P0]`
- **Passos:** ver TC-STOCK-06.
- **Resultado esperado:** reserva é desfeita ao falhar definitivamente; nenhum estoque "preso".

### TC-RESIL-07 — Timeout do ERP é tolerado `[P1]`
- **Pré-condições:** ERP simulado com latência alta.
- **Passos:** criar checkout.
- **Resultado esperado:** o `POST` já respondeu `202`; o worker trata o timeout via retry/falha controlada, sem derrubar a API.

### TC-RESIL-08 — Idempotência do worker em reentrega `[P1]`
- **Passos:** ver TC-IDEM-07.
- **Resultado esperado:** reentrega da mesma mensagem não duplica efeito.

### TC-RESIL-09 — Sem pedido fantasma ao crashar entre gravar e enfileirar `[P2]`
- **Objetivo:** ordem de "gravar pedido" vs "publicar na fila".
- **Passos:** (se simulável) interromper entre persistir o pedido e enfileirar; reiniciar.
- **Resultado esperado:** estratégia documentada (ex.: outbox / publicar-depois-de-gravar com varredura de pendentes) garante que todo pedido `PENDING` acaba sendo processado — sem pedido preso sem job.

---

## 9. Observabilidade (TC-OBS)

### TC-OBS-01 — Endpoint de métricas disponível `[P0]`
- **Passos:** `GET /metrics`.
- **Resultado esperado:** `200`, formato Prometheus (`prom-client`).

### TC-OBS-02 — Métricas de cache hit/miss `[P0]`
- **Passos:** gerar hits e misses; ler `/metrics`.
- **Resultado esperado:** counters de `cache_hit` e `cache_miss` (rotulados por recurso) presentes e crescendo corretamente.

### TC-OBS-03 — Métricas de checkout/fila/worker `[P0]`
- **Resultado esperado:** métricas para checkouts iniciados, jobs processados, jobs falhos/retentados (counters) e, idealmente, duração de processamento (histogram).

### TC-OBS-04 — Métricas do ERP simulado `[P1]`
- **Resultado esperado:** counter/histogram de chamadas ao ERP (sucesso/falha/latência) para detectar degradação.

### TC-OBS-05 — Logs estruturados com correlationId/requestId `[P0]`
- **Passos:** enviar request com header de correlação (ou deixar o sistema gerar); inspecionar logs.
- **Resultado esperado:** logs em JSON contendo `correlationId`/`requestId` em cada entrada da requisição.

### TC-OBS-06 — Logs incluem orderId quando existir `[P0]`
- **Passos:** criar checkout; rastrear logs do pedido.
- **Resultado esperado:** entradas de log do fluxo de checkout/worker carregam o `orderId`, permitindo seguir o pedido ponta-a-ponta.

### TC-OBS-07 — Correlação propaga request → worker `[P1]`
- **Passos:** correlacionar o `correlationId`/`orderId` entre o log do `POST /checkout` e o log do worker.
- **Resultado esperado:** é possível ligar a requisição HTTP ao processamento assíncrono pelo mesmo identificador.

### TC-OBS-08 — Trace/span ligando request, cache, repo e worker `[P2 / bônus]`
- **Pré-condições:** OTel + collector + Jaeger no Compose.
- **Passos:** executar `GET /products` e um checkout; abrir Jaeger UI (`:16686`).
- **Resultado esperado:** traces com spans cobrindo HTTP → cache → repositório fake → worker/ERP (real ou stub justificado).

### TC-OBS-09 — Logs não vazam dados sensíveis nem stacktrace cru ao cliente `[P1]`
- **Resultado esperado:** erros ao cliente são sanitizados (schema de erro); detalhes ficam só nos logs internos.

### TC-OBS-10 — Runbook/alerta/dashboard documentado `[P1]`
- **Passos:** conferir README + provisioning do Grafana/Prometheus.
- **Resultado esperado:** há exemplo de dashboard, regra de alerta (ex.: hit ratio baixo, fila crescendo, taxa de `FAILED` alta) e runbook básico — coerente com o que `/metrics` expõe.

---

## 10. Cenários de Jornada Fim-a-Fim (TC-E2E)

### TC-E2E-01 — Jornada feliz completa `[P0]`
- **Passos:**
  1. `GET /products` (MISS) → `GET /products` (HIT).
  2. `POST /checkout` de item disponível → `202` + `orderId`.
  3. Polling `GET /orders/{orderId}/status` até terminal.
  4. `GET /products` após TTL.
  5. `GET /metrics`.
- **Resultado esperado:** pedido `CONFIRMED`; estoque decrementado e refletido na vitrine pós-TTL; métricas de hit/miss e de checkout coerentes; logs correlacionados por `orderId`.

### TC-E2E-02 — Jornada de falha com reconciliação `[P0]`
- **Pré-condições:** `ERP_FAIL_RATE=1`.
- **Passos:** checkout do último item → aguardar `FAILED` → `GET /products`.
- **Resultado esperado:** pedido `FAILED` com motivo; estoque devolvido; métrica de falha incrementada; logs com `orderId` mostrando os retries.

### TC-E2E-03 — Pico concorrente sem overselling e sem stampede `[P0]`
- **Passos:** estoque `5`; 100 checkouts concorrentes (chaves distintas) + 100 `GET /products` simultâneos.
- **Resultado esperado:** ≤ 5 confirmações; estoque final `0`; poucas chamadas reais ao ERP de leitura (single-flight); API estável (`2xx`/erros controlados, sem `5xx` em massa).

---

## Apêndice — Matriz de variáveis de ambiente relevantes (do Compose)

| Variável | Uso no teste |
|---|---|
| `CACHE_DRIVER` (`memory`/`redis`) | TC-CACHE-07 |
| `STOCK_DRIVER` (`memory`/`redis`) | TC-STOCK-08 |
| `QUEUE_DRIVER` / `IDEMPOTENCY_DRIVER` | TC-RESIL-*, TC-IDEM-* |
| `PRODUCTS_CACHE_TTL_MS` | TC-PROD-06/07, TC-CACHE-01/08 |
| `WORKER_MAX_ATTEMPTS` | TC-RESIL-03/04 |
| `WORKER_BACKOFF_MS` | TC-RESIL-05 |
| `ERP_FAIL_RATE` (`0`..`1`) | TC-RESIL-02/03/04, TC-STOCK-06, TC-E2E-02 |

> **Nota:** alguns casos (TC-CACHE-02 invalidação ativa, TC-RESIL-09 outbox, TC-OBS-08 traces)
> dependem da estratégia escolhida na implementação. Onde o comportamento for "TTL-only"
> ou "stub justificado", o caso deve ser marcado como **N/A documentado** em vez de falha,
> desde que o README explique a decisão (o PDF aceita simplificações justificadas).
