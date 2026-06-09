# Índice de Referência Cruzada — Padrões × Diagramas × Código

> Documento técnico em PT-BR. Liga cada um dos **25 padrões** descritos em
> [`../DESIGN-PATTERNS.md`](../DESIGN-PATTERNS.md) às seções de diagrama Mermaid em
> [`../ARCHITECTURE-DIAGRAM.md`](../ARCHITECTURE-DIAGRAM.md) onde o padrão aparece
> **visualmente**, e aos arquivos de código principais que o implementam.
>
> Este índice **não** redefine os padrões nem os diagramas — apenas correlaciona o que
> já existe nos dois documentos e no código. Não edite os originais a partir daqui.

## Convenções

- **Seção no DESIGN-PATTERNS.md**: deep-link para a seção `### N. Nome` (âncora no formato
  `#n-nome-do-padrão`).
- **Diagrama(s) (§)**: as 5 seções de [`../ARCHITECTURE-DIAGRAM.md`](../ARCHITECTURE-DIAGRAM.md):
  - **§1** = [Visão Hexagonal (Ports & Adapters)](../ARCHITECTURE-DIAGRAM.md#1-visão-hexagonal-ports--adapters)
  - **§2** = [Fluxo de Checkout Assíncrono](../ARCHITECTURE-DIAGRAM.md#2-fluxo-de-checkout-assíncrono-caminho-feliz--202)
  - **§3** = [Máquina de Estados do Pedido](../ARCHITECTURE-DIAGRAM.md#3-máquina-de-estados-do-pedido-domainorderts)
  - **§4** = [Resiliência — Outbox + Reconciliação + Compensação](../ARCHITECTURE-DIAGRAM.md#4-resiliência--outbox-lógico--reconciliação--compensação)
  - **§5** = [Cache-Aside com proteção contra stampede](../ARCHITECTURE-DIAGRAM.md#5-cache-aside-com-proteção-contra-stampede-listproductsusecase)
- **—** na coluna de diagrama = padrão **sem representação visual** atual (candidato a diagrama; ver [Lacunas de cobertura](#lacunas-de-cobertura)).

---

## Tabela mestre (25 padrões)

| # | Padrão | Seção no DESIGN-PATTERNS.md | Diagrama(s) (§) | Arquivos de código principais |
|---|--------|-----------------------------|-----------------|-------------------------------|
| 1 | Ports & Adapters / Hexagonal | [§1](../DESIGN-PATTERNS.md#1-ports--adapters-arquitetura-hexagonal--clean-architecture) | **§1** | `src/application/ports/*.port.ts`, `src/infrastructure/**/ *-adapter.ts`, `src/infrastructure/infrastructure.module.ts` |
| 2 | Dependency Injection (IoC) | [§2](../DESIGN-PATTERNS.md#2-dependency-injection-inversão-de-controle) | **§1** | `src/application/use-cases/checkout.usecase.ts`, `src/application/ports/stock.port.ts` (tokens `Symbol`), `src/infrastructure/infrastructure.module.ts` |
| 3 | Provider / Factory | [§3](../DESIGN-PATTERNS.md#3-provider--factory-criação-condicional-de-adapters) | **§1** | `src/infrastructure/infrastructure.module.ts`, `src/infrastructure/redis.provider.ts` |
| 4 | Singleton | [§4](../DESIGN-PATTERNS.md#4-singleton-escopo-padrão-de-providers-nest) | — | `src/observability/metrics.service.ts`, `src/observability/tracing.service.ts`, `src/infrastructure/redis.provider.ts` |
| 5 | Adapter | [§5](../DESIGN-PATTERNS.md#5-adapter) | **§1** | `src/infrastructure/queue/bullmq-queue.adapter.ts`, `src/infrastructure/stock/redis-stock.adapter.ts`, `src/infrastructure/cache/redis-cache.adapter.ts` |
| 6 | DTO + validação declarativa | [§6](../DESIGN-PATTERNS.md#6-dto-data-transfer-object--validação-declarativa) | **§2** (request `POST /checkout`) | `src/interface/http/dto/checkout.dto.ts`, `src/interface/http/dto/error.dto.ts`, `src/main.ts` (`ValidationPipe`) |
| 7 | Facade | [§7](../DESIGN-PATTERNS.md#7-facade) | **§2** | `src/application/use-cases/checkout.usecase.ts`, `src/interface/http/controllers/checkout.controller.ts` |
| 8 | Strategy (backoff / memory↔redis) | [§8](../DESIGN-PATTERNS.md#8-strategy-backoff-e-seleção-memoryredis) | **§4** (nó `retry + backoff exponencial`) | `src/infrastructure/queue/backoff.strategy.ts`, `src/infrastructure/queue/in-memory-queue.adapter.ts` |
| 9 | Template Method (loop de retry) | [§9](../DESIGN-PATTERNS.md#9-template-method-loop-de-retry-da-fila-in-memory) | **§2**, **§4** | `src/infrastructure/queue/in-memory-queue.adapter.ts`, `src/infrastructure/queue/bullmq-queue.adapter.ts` |
| 10 | Producer–Consumer / Command | [§10](../DESIGN-PATTERNS.md#10-producerconsumer--worker-queue-command-assíncrono) | **§2**, **§4** | `src/application/use-cases/checkout.usecase.ts`, `src/application/use-cases/checkout.worker.ts`, `src/application/ports/queue.port.ts` |
| 11 | State Machine | [§11](../DESIGN-PATTERNS.md#11-state-machine-máquina-de-estados-do-pedido) | **§3** (primário), **§2**, **§4** | `src/domain/order.ts`, `src/domain/errors.ts` |
| 12 | Chain of Responsibility (pipeline HTTP) | [§12](../DESIGN-PATTERNS.md#12-chain-of-responsibility-pipeline-http-middleware--guard--pipe--filter) | — | `src/interface/http/middleware/correlation.middleware.ts`, `src/interface/http/guards/admin-token.guard.ts`, `src/interface/http/filters/domain-exception.filter.ts`, `src/main.ts` |
| 13 | Decorator (Nest / metadados) | [§13](../DESIGN-PATTERNS.md#13-decorator-metadados-declarativos-do-nest) | — | uso pervasivo (`@Controller`, `@Inject`, `@Interval`, `@Catch`, `class-validator`); ex. `src/interface/http/controllers/*.controller.ts`, `src/application/use-cases/reconcile.scheduler.ts` |
| 14 | Idempotência (key + dedupe atômico) | [§14](../DESIGN-PATTERNS.md#14-idempotência-idempotency-key--dedupe-atômico) | **§2** (passo `remember(key)`) | `src/application/ports/idempotency.port.ts`, `src/infrastructure/idempotency/redis-idempotency.adapter.ts`, `src/application/use-cases/checkout.usecase.ts`, `src/application/use-cases/checkout.worker.ts` |
| 15 | Compensating Transaction (sabor Saga) | [§15](../DESIGN-PATTERNS.md#15-compensating-transaction-compensação-de-estoque--sabor-saga) | **§4** (primário), **§2**, **§3** | `src/application/use-cases/checkout.worker.ts`, `src/application/use-cases/checkout.usecase.ts`, `src/application/use-cases/reconcile.usecase.ts` |
| 16 | Retry com Exponential Backoff | [§16](../DESIGN-PATTERNS.md#16-retry-com-exponential-backoff) | **§4** (primário), **§2** | `src/infrastructure/queue/bullmq-queue.adapter.ts`, `src/infrastructure/queue/in-memory-queue.adapter.ts`, `src/infrastructure/queue/backoff.strategy.ts` |
| 17 | Dead Letter Queue (DLQ lógica) | [§17](../DESIGN-PATTERNS.md#17-dead-letter-queue-dlq-lógica) | **§4** (nó `onExhausted … + DLQ`) | `src/infrastructure/queue/bullmq-queue.adapter.ts` |
| 18 | Cache-Aside (+single-flight/stale/jitter) | [§18](../DESIGN-PATTERNS.md#18-cache-aside--single-flight--stale-while-error--ttl-jitter) | **§5** | `src/application/ports/cache.port.ts`, `src/infrastructure/cache/redis-cache.adapter.ts`, `src/infrastructure/cache/in-memory-cache.adapter.ts`, `src/application/use-cases/list-products.usecase.ts` |
| 19 | Reconciliation (anti ghost-order) | [§19](../DESIGN-PATTERNS.md#19-reconciliation-varredura-anti-ghost-order) | **§4** (ramo `ReconcileScheduler`) | `src/application/use-cases/reconcile.usecase.ts`, `src/application/use-cases/reconcile.scheduler.ts`, `src/infrastructure/repositories/in-memory-order.repo.ts` |
| 20 | Outbox (lógico / leve) | [§20](../DESIGN-PATTERNS.md#20-outbox-lógico--leve) | **§4** (primário), **§2** | `src/application/use-cases/checkout.usecase.ts`, `src/application/ports/queue.port.ts` |
| 21 | Entity / Value Object / funções puras | [§21](../DESIGN-PATTERNS.md#21-entity-value-object-e-funções-de-domínio-puras) | **§1** (bloco `domain`), **§3** | `src/domain/order.ts`, `src/domain/stock.ts`, `src/domain/product.ts`, `src/domain/errors.ts` |
| 22 | Domain Error → HTTP (Exception Filter) | [§22](../DESIGN-PATTERNS.md#22-domain-error--http-tradução-por-exception-filter) | — | `src/interface/http/filters/domain-exception.filter.ts`, `src/domain/errors.ts`, `src/interface/http/dto/error.dto.ts` |
| 23 | Ambient Context / Thread-Local (ALS) | [§23](../DESIGN-PATTERNS.md#23-ambient-context--thread-local-asynclocalstorage-para-correlationid) | — | `src/observability/correlation.ts`, `src/interface/http/middleware/correlation.middleware.ts`, `src/application/use-cases/checkout.worker.ts`, `src/observability/tracing.service.ts` |
| 24 | Observer (eventos de fila + métricas) | [§24](../DESIGN-PATTERNS.md#24-observer-eventos-de-fila--métricas) | **§2**, **§4** (ramo de falha → compensação) | `src/infrastructure/queue/bullmq-queue.adapter.ts`, `src/observability/metrics.service.ts` |
| 25 | Lua Script como CAS atômico (anti-TOCTOU) | [§25](../DESIGN-PATTERNS.md#25-lua-script-como-operação-atômica-check-and-set--anti-toctou) | **§2** (`Lua CAS`/`SET NX`), **§4** (`Reserva … Lua CAS`) | `src/infrastructure/stock/redis-stock.adapter.ts`, `src/infrastructure/idempotency/redis-idempotency.adapter.ts`, `src/infrastructure/stock/in-memory-stock.adapter.ts` |

> **Cobertura visual:** 19 de 25 padrões aparecem em pelo menos um diagrama.
> Sem diagrama (**—**): **#4 Singleton, #12 Chain of Responsibility, #13 Decorator,
> #22 Domain Error → HTTP, #23 Ambient Context (ALS), #24 Observer** — observação: o #24
> é *ilustrável* via o ramo de falha de §2/§4 (o evento `failed` que dispara a compensação),
> mas o **conceito Observer em si** não é nomeado no diagrama, então é tratado como
> parcialmente coberto na seção de lacunas.

---

## Tabela inversa — por diagrama

Para cada um dos 5 diagramas, quais padrões ele ilustra (primário = o foco do diagrama;
secundário = aparece como elemento de apoio).

### §1 — Visão Hexagonal (Ports & Adapters)
[Link](../ARCHITECTURE-DIAGRAM.md#1-visão-hexagonal-ports--adapters)

- **Primário:** #1 Ports & Adapters / Hexagonal.
- **Secundários:** #2 Dependency Injection (setas `implements` = inversão de dependência),
  #3 Provider/Factory (seleção `redis ┆ in-memory` no `infrastructure.module.ts`),
  #5 Adapter (blocos `*Adapter` do Driven Side),
  #21 Entity/VO/funções puras (bloco `domain`).
- **Implícito (citável, não rotulado):** #7 Facade (os use cases do bloco `UC` são fachadas).

### §2 — Fluxo de Checkout Assíncrono (caminho feliz + 202)
[Link](../ARCHITECTURE-DIAGRAM.md#2-fluxo-de-checkout-assíncrono-caminho-feliz--202)

- **Primário:** #10 Producer–Consumer / Command (request → enqueue → worker).
- **Secundários:** #14 Idempotência (`remember(key) [Lua SET NX]`),
  #25 Lua CAS (`tryReserve … [Lua CAS]`),
  #20 Outbox lógico (ordem `save(PENDING)` → `enqueue`),
  #11 State Machine (transições `PENDING→PROCESSING→CONFIRMED|FAILED`),
  #16 Retry + Backoff e #9 Template Method (ramo `falha (retry+backoff)`),
  #15 Compensating Transaction (`release(itens) [compensação]`),
  #7 Facade (`Ctl → UC.execute`),
  #6 DTO (request `POST /checkout (Idempotency-Key)`),
  #24 Observer (ramo de falha que dispara `onExhausted`).

### §3 — Máquina de Estados do Pedido
[Link](../ARCHITECTURE-DIAGRAM.md#3-máquina-de-estados-do-pedido-domainorderts)

- **Primário:** #11 State Machine.
- **Secundários:** #21 Entity (a entidade `Order` é quem carrega o estado),
  #15 Compensating Transaction (transições `→ FAILED + release`),
  #19 Reconciliation (transição `PENDING → FAILED` por órfão antigo).

### §4 — Resiliência: Outbox + Reconciliação + Compensação
[Link](../ARCHITECTURE-DIAGRAM.md#4-resiliência--outbox-lógico--reconciliação--compensação)

- **Primário:** #20 Outbox lógico, #19 Reconciliation, #15 Compensating Transaction
  (os três nomeados no título do diagrama).
- **Secundários:** #16 Retry + Backoff (`retry + backoff exponencial`),
  #8 Strategy (a fórmula de backoff por trás desse nó),
  #9 Template Method (loop `EXH? → PROC`),
  #17 Dead Letter Queue (`onExhausted: … + DLQ`),
  #25 Lua CAS (`Reserva estoque (Lua CAS)`),
  #10 Producer–Consumer (`Worker processa`),
  #24 Observer (transição evento-de-falha → compensação).

### §5 — Cache-Aside com proteção contra stampede
[Link](../ARCHITECTURE-DIAGRAM.md#5-cache-aside-com-proteção-contra-stampede-listproductsusecase)

- **Primário:** #18 Cache-Aside (+ single-flight `loader já em voo?`,
  stale-while-error `staleOnError?`, TTL jitter `grava com TTL + jitter`).
- *(Diagrama monotemático — ilustra apenas a família do padrão #18.)*

---

## Lacunas de cobertura

### A. Padrões importantes sem representação visual (candidatos a novo diagrama)

| Padrão | Por que merece diagrama | Tipo de diagrama sugerido |
|--------|-------------------------|----------------------------|
| **#12 Chain of Responsibility** (pipeline HTTP) | A ordem Middleware → Guard → Pipe → Controller → Filter é exatamente o tipo de fluxo sequencial que um diagrama esclarece; hoje a ordem é implícita no texto. | `flowchart LR` ou pequeno `sequenceDiagram` do ciclo de request do Nest, mostrando onde cada elo pode interromper a cadeia. |
| **#23 Ambient Context / ALS** (correlationId) | A propagação de `correlationId` atravessa HTTP → fila → worker → ERP de forma "invisível"; um diagrama tornaria explícito o que o `AsyncLocalStorage` cola. | `sequenceDiagram` ou `flowchart` mostrando `runWithCorrelation` envolvendo request e worker, com logs/spans lendo o contexto. |
| **#22 Domain Error → HTTP** | O mapeamento `DomainError.code → status HTTP` (404/409/500) é uma tabela de decisão clara; é o complemento de erro do §2 (caminho feliz). | `flowchart` de decisão `statusFor()` ou tabela visual de mapeamento erro→status. |
| **#24 Observer** | Está *parcialmente* ilustrado (ramo de falha de §2/§4), mas o mecanismo `worker.on('failed', …)` e as métricas como observadores passivos não são nomeados. | Anotar nos diagramas existentes (ver B) em vez de criar um novo. |

Padrões **#4 Singleton** e **#13 Decorator** também estão sem diagrama, mas são
**transversais/estruturais do framework** e dificilmente rendem um diagrama útil — a ausência
é aceitável e não se recomenda criar diagramas dedicados para eles.

### B. Diagramas que poderiam citar o padrão no texto

- **§1 (Hexagonal):** o texto de leitura já descreve a inversão de dependência (#2 DI) e o
  Adapter (#5), mas poderia **nomear explicitamente** #3 Provider/Factory (a seleção
  `redis ┆ in-memory` é a Factory em ação) e #7 Facade (os use cases do bloco `UC`).
- **§2 (Checkout):** poderia anotar que o passo `remember(key)` é **#14 Idempotência**,
  que `tryReserve [Lua CAS]` é **#25 Lua CAS atômico**, que a ordem save→enqueue é
  **#20 Outbox lógico**, e que o ramo de falha exemplifica **#24 Observer** + **#9 Template
  Method**. Hoje esses rótulos estão só no `DESIGN-PATTERNS.md`.
- **§3 (State Machine):** poderia citar que `→ FAILED + release` é **#15 Compensating
  Transaction** e que a transição por órfão antigo vem de **#19 Reconciliation**.
- **§4 (Resiliência):** poderia nomear **#8 Strategy** por trás do nó de backoff e
  **#9 Template Method** no loop de retry — atualmente só `retry + backoff` aparece.
- **§5 (Cache-Aside):** já cobre bem a família #18; poderia mencionar no texto introdutório
  que single-flight + stale-while-error + TTL jitter são *sub-padrões* de #18 (hoje o texto
  do §5 é só o diagrama, sem prosa).

---

> Gerado como índice de coerência cruzada. Fontes: [`../DESIGN-PATTERNS.md`](../DESIGN-PATTERNS.md)
> (25 padrões) e [`../ARCHITECTURE-DIAGRAM.md`](../ARCHITECTURE-DIAGRAM.md) (5 diagramas §1–§5).
