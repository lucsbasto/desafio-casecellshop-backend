# Índice de Revisão de Código

## Visão geral do escopo revisado

- **Arquivos revisados:** 55
- **Total de achados por severidade (todos os arquivos):**

| Severidade | Total |
| --- | --- |
| CRITICAL | 2 |
| HIGH | 45 |
| MEDIUM | 121 |
| LOW | 191 |
| **Total geral** | **359** |

Os 2 achados CRITICAL concentram-se no fluxo de processamento assíncrono de checkout (`checkout.worker.ts`) e na reconciliação (`reconcile.usecase.ts`), ambos relacionados a corridas de concorrência sem escrita atômica/condicional que podem causar dupla fatura no ERP e double-release de estoque (oversell).

---

## Tabela de achados por arquivo

Ordenada por severidade (arquivos com CRITICAL primeiro, depois por HIGH, MEDIUM e LOW decrescentes).

| Arquivo | Crit | High | Med | Low | Veredito |
| --- | :---: | :---: | :---: | :---: | --- |
| [reconcile.usecase.ts](application/use-cases/reconcile.usecase.md) | 1 | 3 | 3 | 3 | Requer mudanças |
| [checkout.worker.ts](application/use-cases/checkout.worker.md) | 1 | 2 | 3 | 3 | Requer mudanças |
| [redis-stock.adapter.ts](infrastructure/stock/redis-stock.adapter.md) | 0 | 2 | 3 | 4 | Aprovado com ressalvas |
| [bullmq-queue.adapter.ts](infrastructure/queue/bullmq-queue.adapter.md) | 0 | 2 | 4 | 4 | Aprovado com ressalvas |
| [app-config.ts](infrastructure/config/app-config.md) | 0 | 2 | 4 | 4 | Aprovado com ressalvas |
| [cache.port.ts](application/ports/cache.port.md) | 0 | 2 | 4 | 3 | Aprovado com ressalvas |
| [cache.spec.ts](infrastructure/cache/cache.spec.md) | 0 | 2 | 4 | 3 | Aprovado com ressalvas |
| [checkout.usecase.ts](application/use-cases/checkout.usecase.md) | 0 | 2 | 3 | 4 | Aprovado com ressalvas |
| [list-products.usecase.ts](application/use-cases/list-products.usecase.md) | 0 | 2 | 3 | 3 | Aprovado com ressalvas |
| [in-memory-cache.adapter.ts](infrastructure/cache/in-memory-cache.adapter.md) | 0 | 2 | 3 | 4 | Aprovado com ressalvas |
| [redis-cache.adapter.ts](infrastructure/cache/redis-cache.adapter.md) | 0 | 2 | 3 | 3 | Aprovado com ressalvas |
| [in-memory-order.repo.ts](infrastructure/repo/in-memory-order.repo.md) | 0 | 2 | 3 | 3 | Aprovado com ressalvas |
| [domain-exception.filter.ts](interface/http/filters/domain-exception.filter.md) | 0 | 2 | 3 | 3 | Aprovado com ressalvas |
| [admin-token.guard.ts](interface/http/guards/admin-token.guard.md) | 0 | 2 | 2 | 3 | Aprovado com ressalvas |
| [order.spec.ts](domain/order.spec.md) | 0 | 2 | 4 | 3 | Aprovado com ressalvas |
| [queue.port.ts](application/ports/queue.port.md) | 0 | 1 | 4 | 4 | Aprovado com ressalvas |
| [repository.port.ts](application/ports/repository.port.md) | 0 | 1 | 3 | 3 | Aprovado com ressalvas |
| [reconcile.scheduler.ts](application/reconcile.scheduler.md) | 0 | 1 | 2 | 3 | Aprovado com ressalvas |
| [stock.ts](domain/stock.md) | 0 | 1 | 3 | 3 | Aprovado com ressalvas |
| [in-memory-idempotency.adapter.ts](infrastructure/idempotency/in-memory-idempotency.adapter.md) | 0 | 1 | 1 | 3 | Aprovado com ressalvas |
| [redis-idempotency.adapter.ts](infrastructure/idempotency/redis-idempotency.adapter.md) | 0 | 1 | 3 | 4 | Aprovado com ressalvas |
| [infrastructure.module.ts](infrastructure/infrastructure.module.md) | 0 | 1 | 2 | 3 | Aprovado com ressalvas |
| [in-memory-queue.adapter.ts](infrastructure/queue/in-memory-queue.adapter.md) | 0 | 1 | 2 | 3 | Aprovado com ressalvas |
| [redis.provider.ts](infrastructure/redis.provider.md) | 0 | 1 | 3 | 4 | Aprovado com ressalvas |
| [checkout.controller.ts](interface/http/controllers/checkout.controller.md) | 0 | 1 | 3 | 3 | Aprovado com ressalvas |
| [correlation.middleware.ts](observability/correlation.middleware.md) | 0 | 1 | 2 | 3 | Aprovado com ressalvas |
| [logger.config.ts](observability/logger.config.md) | 0 | 1 | 3 | 4 | Aprovado com ressalvas |
| [metrics.controller.ts](observability/metrics.controller.md) | 0 | 1 | 2 | 2 | Aprovado com ressalvas |
| [http.e2e.spec.ts](e2e/http.e2e.spec.md) | 0 | 1 | 3 | 5 | Aprovado com ressalvas |
| [idempotency.port.ts](application/ports/idempotency.port.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [stock.port.ts](application/ports/stock.port.md) | 0 | 0 | 3 | 4 | Aprovado com ressalvas |
| [errors.ts](domain/errors.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [order.ts](domain/order.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [product.ts](domain/product.md) | 0 | 0 | 2 | 3 | Aprovado com ressalvas |
| [fake-erp.client.ts](infrastructure/erp/fake-erp.client.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [in-memory-product.repo.ts](infrastructure/repo/in-memory-product.repo.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [backoff.strategy.ts](infrastructure/queue/backoff.strategy.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [in-memory-stock.adapter.ts](infrastructure/stock/in-memory-stock.adapter.md) | 0 | 0 | 1 | 4 | Aprovado com ressalvas |
| [admin.controller.ts](interface/http/controllers/admin.controller.md) | 0 | 0 | 2 | 3 | Aprovado com ressalvas |
| [orders.controller.ts](interface/http/controllers/orders.controller.md) | 0 | 0 | 2 | 3 | Aprovado com ressalvas |
| [checkout.dto.ts](interface/http/dto/checkout.dto.md) | 0 | 0 | 2 | 3 | Aprovado com ressalvas |
| [order.dto.ts](interface/http/dto/order.dto.md) | 0 | 0 | 1 | 4 | Aprovado com ressalvas |
| [correlation.ts](observability/correlation.md) | 0 | 0 | 1 | 4 | Aprovado com ressalvas |
| [metrics.service.ts](observability/metrics.service.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [tracing.service.ts](observability/tracing.service.md) | 0 | 0 | 2 | 3 | Aprovado com ressalvas |
| [stock-concurrency.spec.ts](infrastructure/stock/stock-concurrency.spec.md) | 0 | 0 | 2 | 4 | Aprovado com ressalvas |
| [checkout-flow.spec.ts](application/use-cases/checkout-flow.spec.md) | 0 | 0 | 2 | 5 | Aprovado com ressalvas |
| [products.controller.ts](interface/http/controllers/products.controller.md) | 0 | 0 | 1 | 3 | Aprovado com ressalvas |
| [erp.port.ts](application/ports/erp.port.md) | 0 | 0 | 0 | 4 | Aprovado |
| [application.module.ts](application/application.module.md) | 0 | 0 | 0 | 3 | Aprovado |
| [get-order-status.usecase.ts](application/use-cases/get-order-status.usecase.md) | 0 | 0 | 0 | 3 | Aprovado |
| [health.controller.ts](interface/http/controllers/health.controller.md) | 0 | 0 | 1 | 3 | Aprovado |
| [error.dto.ts](interface/http/dto/error.dto.md) | 0 | 0 | 0 | 3 | Aprovado |
| [product.dto.ts](interface/http/dto/product.dto.md) | 0 | 0 | 0 | 4 | Aprovado |
| [observability.module.ts](observability/observability.module.md) | 0 | 0 | 0 | 3 | Aprovado |

---

## Temas transversais

Padrões de problema que se repetem em múltiplos arquivos, do mais grave ao menos:

### 1. Concorrência sem escrita atômica/condicional (CRITICAL/HIGH)

O tema mais grave e recorrente. A `RepositoryPort.save()` é um upsert incondicional, sem CAS/optimistic-lock. O padrão read-modify-write usado em vários fluxos abre janelas de lost update, dupla fatura no ERP e double-release de estoque (oversell) sob workers paralelos ou entrega duplicada do BullMQ.
- `reconcile.usecase.ts` (C1: snapshot stale sem re-leitura/lock — corrida com o worker)
- `checkout.worker.ts` (CRITICAL: TOCTOU no guard de PROCESSING; HIGH: lost update CONFIRMED-após-FAILED)
- `repository.port.ts` (HIGH: ausência de primitiva de escrita atômica)
- `in-memory-order.repo.ts` (H1: save last-write-wins sem versão/CAS)
- `reconcile.scheduler.ts` (HIGH: `@Interval` sem guarda de re-entrância)
- `redis-stock.adapter.ts` (HIGH: release sem teto, infla estoque sob retries)
- `bullmq-queue.adapter.ts` (HIGH: register sem guard cria Workers duplicados)

### 2. Compensação de estoque frágil / falha parcial silenciosa (CRITICAL/HIGH)

Caminhos de compensação (release de estoque) usam `Promise.all` sem catch ou abortam no primeiro erro, deixando reservas presas permanentemente (oversell) e mascarando o erro original.
- `checkout.worker.ts` (HIGH: `Promise.all` sem catch na compensação)
- `checkout.usecase.ts` (H2: erro em release mascara o erro original e aborta o loop)
- `reconcile.usecase.ts` (M1/M2: save+release não-atômicos, `Promise.all` aborta)
- `in-memory-queue.adapter.ts` (HIGH: falha de compensação engolida por `.catch(() => undefined)`)
- `stock.ts` (MEDIUM: release engole quantidade negativa silenciosamente)

### 3. Falta de validação de entrada na fronteira (HIGH)

Entradas controladas pelo cliente (header `Idempotency-Key`, `correlationId`, params de rota) fluem sem validação de tamanho/charset até chaves Redis, logs e spans — vetores de DoS, poluição de keyspace e log injection.
- `checkout.controller.ts` (H1: `Idempotency-Key` sem validação → chave Redis)
- `checkout.dto.ts` (M1: header sem o mesmo MaxLength/Matches do productId)
- `correlation.middleware.ts` (HIGH: header não confiável, cast `as string` ignora arrays)
- `logger.config.ts` (HIGH: correlationId de header refletido em logs/response sem sanitização)
- `app-config.ts` (H1: invariantes numéricas/faixas não validadas, sem fail-fast)
- `products.controller.ts` / `orders.controller.ts` (MEDIUM: param `:id` sem ParseUUIDPipe)

### 4. Entradas não-finitas/fracionárias corrompendo estoque e TTL (HIGH/MEDIUM)

`NaN`/`Infinity`/frações e `ttlMs` não normalizado furam guardas de domínio e adapters, gerando oversell silencioso, idempotência desligada e divergência entre drivers in-memory e Redis.
- `stock.ts` (HIGH: NaN/Infinity/frações retornam `{ok:true, remaining:NaN}`)
- `redis-stock.adapter.ts` (HIGH: quantidade fracionária lança exceção bruta do Redis)
- `cache.port.ts` / `in-memory-cache.adapter.ts` (ttlMs sem clamp; Redis defende, in-memory não)
- `in-memory-idempotency.adapter.ts` / `redis-idempotency.adapter.ts` (ttlMs NaN quebra idempotência)
- `stock.port.ts` / `in-memory-stock.adapter.ts` (contrato não fixa quantity inteiro não-negativo)

### 5. Vazamento de memória (cache/idempotência/lastKnown ilimitados) (HIGH)

Estruturas in-process crescem sem LRU/cap/eviction de expirados, levando a OOM, e o fallback stale só funciona na instância que gravou a chave (inconsistente em multi-instância).
- `in-memory-cache.adapter.ts` (H1: store e lastKnown sem limite)
- `redis-cache.adapter.ts` (H1: lastKnown Map in-process ilimitado)
- `in-memory-idempotency.adapter.ts` (HIGH: entradas expiradas nunca evictadas)

### 6. Cache: colisão de chave, penetration e single-flight entre instâncias (HIGH)

- `list-products.usecase.ts` (H1: `products:all` colide com `getById('all')`; H2: cache penetration de id inexistente contra o ERP)
- `cache.port.ts` (H1: sentinela `undefined`=miss quebra negative caching)
- `redis-cache.adapter.ts` (H2: single-flight só in-process, lock SET NX só documentado, não implementado)

### 7. Tratamento de erro / observabilidade silenciosa (HIGH/MEDIUM)

500s silenciosos, vazamento de nome de classe interna no contrato, `(err as Error).message` assumindo Error, e falhas de coleta/scheduler sem log nem métrica.
- `domain-exception.filter.ts` (H1: 500 silencioso sem log; H2: vaza nome de classe do NestJS)
- `tracing.service.ts` (M1: `(err as Error).message` mascara erro não-Error)
- `checkout.worker.ts` / `reconcile.scheduler.ts` (descarte de stack trace; falha silenciosa a cada tick)
- `metrics.controller.ts` (MEDIUM: sem try/catch em `expose()`)

### 8. Segurança de superfície administrativa e telemetria (HIGH)

- `admin-token.guard.ts` (HIGH: comparação de token não constant-time; HIGH: fail-open sem ADMIN_TOKEN)
- `metrics.controller.ts` (HIGH: `/metrics` exposto sem guard, vaza telemetria de negócio)

### 9. Contratos de porta subespecificados (MEDIUM, transversal a quase todas as ports)

Semântica de `attempt`, `hit`, replay de idempotência, paginação de `findPendingOlderThan`, idempotência do ERP e serializabilidade de `T` ficam garantidas apenas por convenção dos adapters, divergindo entre in-memory e Redis.

---

## Prioridade de correção

Lista ordenada dos itens CRITICAL e HIGH mais importantes (impacto de negócio primeiro: dupla fatura e oversell).

### CRITICAL

1. **TOCTOU no guard anti-duplo-faturamento** — `checkout.worker.ts`: `save()` sem CAS permite dois workers faturarem o mesmo pedido no ERP (dupla nota fiscal).
2. **Caminho FAILED sobre snapshot stale sem re-leitura/lock** — `reconcile.usecase.ts` (C1): corrida com o `CheckoutWorker` causa double-release de estoque (oversell) e/ou marca FAILED um pedido já faturado.

### HIGH

3. **`save()` sem locking otimista → lost update** — `checkout.worker.ts`: pedido CONFIRMED após FAILED com estoque já liberado (oversell).
4. **Ausência de primitiva de escrita atômica/condicional na porta** — `repository.port.ts`: raiz dos problemas de concorrência do checkout.
5. **`save` last-write-wins sem CAS** — `in-memory-order.repo.ts` (H1): marca FAILED um pedido já CONFIRMED.
6. **`@Interval` sem guarda de re-entrância** — `reconcile.scheduler.ts`: overlap duplica compensação de estoque.
7. **Sem lock/idempotência da reconciliação** — `reconcile.usecase.ts` (H3): execuções concorrentes (HA/overlap) causam double-enqueue e double-release.
8. **Compensação com `Promise.all` sem catch** — `checkout.worker.ts` / `checkout.usecase.ts` (H2) / `in-memory-queue.adapter.ts`: falha parcial deixa estoque reservado permanentemente.
9. **NaN/Infinity/frações furam o anti-oversell** — `stock.ts`: retornam `{ok:true, remaining:NaN}` (oversell silencioso).
10. **Quantidade fracionária + release sem teto no Redis** — `redis-stock.adapter.ts`: exceção bruta e inflação de estoque sob retries.
11. **`semântica de `attempt` indefinida** — `queue.port.ts` (H1): divergência entre adapters vira risco de dupla fatura na guarda do worker.
12. **`createdAt` inválido → re-enqueue eterno / pedido órfão** — `reconcile.usecase.ts` (H2) / `in-memory-order.repo.ts` (H2): estoque preso permanentemente.
13. **Loop de reconciliação sem try/catch por item** — `reconcile.usecase.ts` (H1): uma transição inválida aborta toda a rodada.
14. **`Idempotency-Key` / correlationId sem validação** — `checkout.controller.ts` (H1) / `correlation.middleware.ts` / `logger.config.ts`: DoS, poluição de keyspace e log injection.
15. **Fail-open e comparação não constant-time no admin** — `admin-token.guard.ts`: única barreira de um endpoint destrutivo.
16. **`/metrics` sem guard** — `metrics.controller.ts`: vaza telemetria de negócio (checkout, fila, oversell).
17. **Vazamento de memória (cache/idempotência/lastKnown)** — `in-memory-cache.adapter.ts` / `redis-cache.adapter.ts` / `in-memory-idempotency.adapter.ts`: OOM e fallback inconsistente em multi-instância.
18. **Cache: colisão `products:all` e penetration** — `list-products.usecase.ts` (H1/H2): corrupção do cache de listagem e DoS via ERP.
19. **500 silencioso e vazamento de classe interna** — `domain-exception.filter.ts` (H1/H2): toda resposta de erro da API passa por aqui.
20. **`register()` sem guard / sem handler `.on('error')`** — `bullmq-queue.adapter.ts`: Workers duplicados, vazamento de conexão e processo derrubado por erro de conexão Redis.
21. **Falta de validação de invariantes de config (fail-fast no boot)** — `app-config.ts` (H1/H2): faixas inválidas e driver degradado silenciosamente.
22. **`quit()` no shutdown sem fallback** — `redis.provider.ts`: pode travar a sequência de shutdown do Nest em outage do Redis.
23. **`StockSeeder.onModuleInit` sobrescreve estoque incondicionalmente** — `infrastructure.module.ts`: clobber + race em multi-instância.
24. **`eval` reenvia script Lua no caminho quente** — `redis-idempotency.adapter.ts`: usar `defineCommand`/EVALSHA.
