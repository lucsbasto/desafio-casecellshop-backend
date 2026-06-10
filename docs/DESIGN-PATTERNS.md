# Design Patterns — CaseCellShop Backend

> 🔗 **Navegação:** [`../README.md`](../README.md) · [`ARCHITECTURE-DIAGRAM.md`](./ARCHITECTURE-DIAGRAM.md) (diagramas Mermaid) · [`RESPOSTAS-CONCEITUAIS.md`](./RESPOSTAS-CONCEITUAIS.md)

> Documento técnico em PT-BR. Cada padrão é descrito com **evidência concreta** (arquivo:linha lida do código real), motivação no contexto do sistema de checkout assíncrono / estoque / fila, tradeoffs e benefícios. Ao final, uma seção crítica de padrões **deliberadamente não utilizados**, uma tabela-resumo e a conclusão.

O sistema é um backend NestJS/TypeScript para uma loja de capinhas. O fluxo central é um **checkout assíncrono**: o request reserva estoque atomicamente, persiste o pedido `PENDING`, enfileira um job e responde `202 Accepted`; um worker fatura no "ERP" (fake) com retry/backoff e, ao esgotar tentativas, compensa o estoque (`FAILED`). Há ainda catálogo com cache, idempotência, reconciliação periódica e observabilidade.

---

## Padrões Arquiteturais

### 1. Ports & Adapters (Arquitetura Hexagonal / Clean Architecture)
**Categoria:** Arquitetural
**Onde:**
- Ports (interfaces puras, sem dependência de framework de infra): `src/application/ports/cache.port.ts`, `stock.port.ts`, `idempotency.port.ts`, `queue.port.ts`, `repository.port.ts`, `erp.port.ts`.
- Adapters de infra implementando os ports: `src/infrastructure/stock/redis-stock.adapter.ts:11` (`implements StockPort`), `src/infrastructure/cache/redis-cache.adapter.ts:9` (`implements CachePort`), `src/infrastructure/queue/bullmq-queue.adapter.ts:34` (`implements QueuePort`), etc.
- Camadas separadas em diretórios: `domain/` (regras puras) ← `application/` (use cases + ports) ← `infrastructure/` (adapters) e `interface/http/` (entrada HTTP).

**Por que escolhemos:** o caso pede que a solução rode tanto sem dependências externas (in-memory, "sem Docker") quanto com Redis/BullMQ em produção. Definir os contratos como ports permite trocar a implementação (memory ↔ redis) sem tocar no domínio nem nos use cases. O domínio (`src/domain/order.ts`, `errors.ts`) não conhece HTTP, Redis ou Nest — a tradução para HTTP fica isolada no filter (`src/interface/http/filters/domain-exception.filter.ts:21`, comentário "keeping the domain agnostic of HTTP").

**Tradeoffs:** mais arquivos e indireção (cada capability tem port + 2 adapters). Para um CRUD trivial seria over-engineering; aqui paga porque há genuinamente duas implementações de cada port e um requisito de testabilidade/swap.

**Pontos positivos concretos:** testes de fluxo rodam com adapters in-memory determinísticos (`src/application/use-cases/checkout-flow.spec.ts`); a mesma lógica de negócio é exercida em produção com Redis. Zero acoplamento do domínio com infra.

---

### 2. Dependency Injection (Inversão de Controle)
**Categoria:** Arquitetural / Criacional
**Onde:** todos os use cases recebem ports via construtor com `@Inject(TOKEN)` — ex. `src/application/use-cases/checkout.usecase.ts:46-55` injeta `STOCK_PORT`, `IDEMPOTENCY_PORT`, `QUEUE_PORT`, `ORDER_REPO_PORT`, `PRODUCT_REPO_PORT`, `APP_CONFIG`, `MetricsService`, `TracingService`. Tokens são `Symbol`s (`src/application/ports/stock.port.ts:1` `export const STOCK_PORT = Symbol('STOCK_PORT')`).

**Por que escolhemos:** os ports são interfaces TypeScript (apagadas em runtime), então não dá para injetar pela classe. Usar `Symbol` como token + `@Inject` resolve isso e mantém o use case dependente apenas da abstração. O container do Nest decide a implementação concreta no wiring (`infrastructure.module.ts`).

**Tradeoffs:** verbosidade de `@Inject(SYMBOL)` em vez de injeção por tipo; tokens precisam ser exportados/importados. É o custo padrão de DI baseada em interface em TS.

**Pontos positivos:** substituição trivial em testes (passar fakes), e o grafo de dependências fica explícito e auditável.

---

### 3. Provider / Factory (criação condicional de adapters)
**Categoria:** Criacional
**Onde:** `src/infrastructure/infrastructure.module.ts:34-97` — `CacheProvider`, `StockProvider`, `IdempotencyProvider`, `QueueProvider`, etc., todos `useFactory` que escolhem o adapter conforme `cfg.drivers.*`. Exemplo (`:43-50`):
```ts
const StockProvider: Provider = {
  provide: STOCK_PORT,
  inject: [APP_CONFIG, REDIS_CLIENT],
  useFactory: (cfg, redis) =>
    cfg.drivers.stock === 'redis'
      ? new RedisStockAdapter(requireRedis(redis))
      : new InMemoryStockAdapter(),
};
```
Também `RedisProvider` (`src/infrastructure/redis.provider.ts:16-27`) que cria a conexão ioredis **apenas** se algum driver for `redis` (senão retorna `null`).

**Por que escolhemos:** a decisão "memory vs redis" é de runtime (variável de ambiente), não de compilação. A Factory encapsula essa lógica de seleção/instanciação num único lugar.

**Tradeoffs:** factories crescem com o número de capabilities; `requireRedis()` (`infrastructure.module.ts:27-30`) precisa lançar erro quando o driver pede Redis mas a conexão é nula — um acoplamento implícito entre providers.

**Pontos positivos:** um único ponto verdade para o wiring; rodar 100% em memória não instancia nenhum recurso Redis (sem Docker para o avaliador).

---

### 4. Singleton (escopo padrão de providers Nest)
**Categoria:** Criacional
**Onde:** todos os `@Injectable()` e providers (default scope do Nest é singleton). Ex.: `MetricsService` (`src/observability/metrics.service.ts:10` → `registry`) mantém um único `Registry` Prometheus compartilhado por toda a app; `TracingService` (`tracing.service.ts:28-29` → `maxBuffer`/`finished`) mantém um buffer único de spans; a conexão ioredis é singleton via `REDIS_CLIENT`.

**Por que escolhemos:** métricas, registry de tracing e conexão Redis precisam ser instâncias únicas — múltiplos registries dariam métricas fragmentadas e múltiplas conexões desperdiçariam recursos.

**Tradeoffs:** estado compartilhado exige cuidado com concorrência (mitigado pelo single-thread do Node e pela natureza thread-safe das libs usadas).

**Pontos positivos:** `/metrics` agrega tudo num registry; o buffer de spans é coerente.

---

## Padrões Estruturais

### 5. Adapter
**Categoria:** Estrutural
**Onde:** todos os `*-adapter.ts` em `src/infrastructure/**`. Exemplos load-bearing:
- `src/infrastructure/queue/bullmq-queue.adapter.ts:13-22` — `toConnection()` adapta `REDIS_URL` (string) para `ConnectionOptions` do BullMQ; a classe adapta a API do BullMQ (`Queue`, `Worker`, `QueueEvents`) ao `QueuePort` simples (`enqueue/register/depth/close`).
- `src/infrastructure/stock/redis-stock.adapter.ts` — adapta operações Redis (Lua/`DECRBY`) ao `StockPort`.

**Por que escolhemos:** as APIs de bibliotecas externas (BullMQ, ioredis, prom-client) são ricas e específicas; o domínio quer um contrato mínimo. O Adapter traduz uma na outra.

**Tradeoffs:** uma camada extra de tradução; risco de "vazar" semântica específica do backend através do port (ex.: o conceito de `attempt` 1-based teve que ser harmonizado entre BullMQ `attemptsMade + 1` em `bullmq-queue.adapter.ts:63` e a fila in-memory).

**Pontos positivos:** o use case nunca importa `bullmq` nem `ioredis`. Trocar a fila não toca no worker.

---

### 6. DTO (Data Transfer Object) + validação declarativa
**Categoria:** Estrutural
**Onde:** `src/interface/http/dto/*.ts`. `CheckoutRequestDto`/`CheckoutItemDto` (`checkout.dto.ts:18-43`) com decorators `class-validator` (`@IsInt`, `@Min`, `@Max`, `@ArrayMaxSize(50)`, `@Matches(/^[A-Za-z0-9_-]+$/)`). `ErrorDto` (`error.dto.ts`) padroniza o corpo de erro. Validação global ligada em `src/main.ts:18-20` (`ValidationPipe` com `whitelist`, `transform`, `forbidNonWhitelisted`).

**Por que escolhemos:** separar o contrato de entrada/saída HTTP do modelo de domínio. A validação na borda evita que dados inválidos cheguem ao use case; o `@Matches` é defensivo porque `productId` vira chave Redis (`checkout.dto.ts:22` comentário).

**Tradeoffs:** duplicação parcial entre DTO e tipos de domínio (`OrderItem`); mapeamento manual no controller (`orders.controller.ts:16-26`).

**Pontos positivos:** 400 padronizado e automático; OpenAPI gerado dos mesmos decorators (`@ApiProperty`).

---

### 7. Facade
**Categoria:** Estrutural
**Onde:** os Use Cases atuam como fachadas que escondem a orquestração de múltiplos ports atrás de um único método. `CheckoutUseCase.execute()` (`checkout.usecase.ts:57`) esconde idempotência + reserva + persistência + enfileiramento + métricas. O controller (`checkout.controller.ts:36-46`) só chama `this.checkout.execute(...)`.

**Por que escolhemos:** o controller deve ser fino (HTTP-only); a complexidade transacional fica numa fachada de aplicação coesa.

**Tradeoffs:** use cases podem inchar se acumularem responsabilidades — por isso o `run()` do checkout foi decomposto (Extract Method `reserveItems` + factory `createPendingOrder`), ficando legível como os 4 passos do fluxo em vez de um método único longo.

**Pontos positivos:** controllers triviais, lógica testável isoladamente.

---

## Padrões Comportamentais

### 8. Strategy (backoff e seleção memory/redis)
**Categoria:** Comportamental
**Onde:** `src/infrastructure/queue/backoff.strategy.ts` — interface `BackoffStrategy` (`:9-12`) com implementação `ExponentialBackoff` (`:15-27`). Consumida pela fila in-memory (`in-memory-queue.adapter.ts:27`). O próprio comentário do arquivo cita explicitamente o padrão Strategy (`backoff.strategy.ts:1`). A seleção memory↔redis nos providers também é uma forma de Strategy de runtime.

**Por que escolhemos:** a fórmula de backoff exponencial (`base * factor^(attempt-2)`, com teto) precisava ser **única fonte de verdade** compartilhada entre a fila in-memory e (conceitualmente) o BullMQ, sem duplicar a fórmula. Extrair em uma interface permite injetar estratégias diferentes (ex.: backoff fixo, jitter) e tornar o backoff determinístico/instantâneo em testes (`backoffFactor: 0`).

**Tradeoffs:** abstração extra para algo que poderia ser uma função; justifica-se pela necessidade de testes determinísticos e reuso.

**Pontos positivos:** testes da fila não dependem de tempo real; a regra de delay fica isolada e unitariamente testável.

---

### 9. Template Method (loop de retry da fila + base de cache)
**Categoria:** Comportamental
**Onde:** dois usos load-bearing do mesmo padrão:
- **Fila in-memory:** `src/infrastructure/queue/in-memory-queue.adapter.ts:52-69` — `run()` define o esqueleto invariante (tentar → em erro, checar `maxAttempts` → backoff → repetir → `onExhausted`), delegando os passos variáveis (`process`, `onExhausted`) ao `QueueProcessor` registrado.
- **Adapters de cache:** `src/infrastructure/cache/abstract-cache.adapter.ts:14` — `AbstractCacheAdapter` é o exemplo canônico do padrão: o método-template `getOrLoad()` (`:39-78`) implementa o algoritmo invariante (hit → single-flight → load+`set` → fallback stale-while-error) e delega às **primitivas abstratas** `get()`/`del()`/`writeStore()` (`:24,26,32`) que cada driver implementa — `InMemoryCacheAdapter` dobra o TTL jitterizado em `expiresAt` (`in-memory-cache.adapter.ts:27-29`), `RedisCacheAdapter` o passa como `PX` (`redis-cache.adapter.ts:32-34`).

**Por que escolhemos:** o algoritmo é fixo e o que varia é apenas o passo concreto. Na fila, o que varia é a lógica de negócio (faturar no ERP) e a compensação, fornecidas pelo `CheckoutWorker`. No cache, a orquestração single-flight + stale-while-error + jitter era **duplicada verbatim** entre os dois adapters; extraí-la para a superclasse (refactoring *Form Template Method*) eliminou a duplicação e deixou cada subclasse só com seu I/O específico (Map vs Redis) — um bugfix no coalescing agora é feito num lugar só.

**Tradeoffs:** o "template" acopla-se ao contrato dos passos abstratos (`QueueProcessor` na fila; `get`/`writeStore`/`del` no cache); mudanças no contrato afetam todas as subclasses.

**Pontos positivos:** o BullMQ adapter implementa o **mesmo** template de retry (retry nativo + evento `failed` → `onExhausted`, `bullmq-queue.adapter.ts:68-81`), garantindo paridade comportamental memory/redis; e os dois adapters de cache passaram a compartilhar uma única implementação de `getOrLoad`, com paridade garantida por characterization tests dedicados (`cache.spec.ts`).

---

### 10. Producer–Consumer / Worker Queue (Command assíncrono)
**Categoria:** Comportamental / Arquitetural
**Onde:** Producer: `CheckoutUseCase` enfileira `CheckoutJob` (`checkout.usecase.ts:109-111`). Consumer: `CheckoutWorker` registra-se como processor no boot (`checkout.worker.ts:29-31` `onModuleInit → queue.register(this)`) e processa (`process()` `:33`). O `CheckoutJob` (`queue.port.ts:3-7`) é efetivamente um **Command** serializável (`orderId` + `correlationId`).

**Por que escolhemos:** o ERP é lento e instável (offender do case). Desacoplar a faturação do request HTTP permite responder `202` rápido e processar em background com retry — o coração da solução.

**Tradeoffs:** complexidade de estado assíncrono (pedido `PENDING` antes de confirmar), necessidade de idempotência no consumer e de reconciliação para jobs perdidos.

**Pontos positivos:** request rápido e resiliente; throughput desacoplado da latência do ERP.

---

### 11. State Machine (máquina de estados do pedido)
**Categoria:** Comportamental
**Onde:** `src/domain/order.ts:39-71` — mapa `ALLOWED` de transições válidas, `canTransition()` (`:52`), `transition()` (`:60`, função pura que valida e retorna novo `Order`), `isTerminal()` (`:48`). Transição inválida lança `InvalidOrderTransitionError` (`errors.ts:37`).

**Por que escolhemos:** o pedido tem ciclo de vida bem definido (`PENDING → PROCESSING → CONFIRMED|FAILED`) com regras críticas — ex.: `PROCESSING` nunca volta para `PENDING` (`order.ts:41-42`) para a reconciliação não re-enfileirar um pedido com worker ativo (anti double-processing).

**Tradeoffs:** rigidez — adicionar um estado exige editar o mapa e revisar invariantes.

**Pontos positivos:** transições inválidas são impossíveis por construção; a pureza (`transition` não muta, `:61` é idempotente) facilita raciocínio e testes (`order.spec.ts`).

---

### 12. Chain of Responsibility (pipeline HTTP: Middleware → Guard → Pipe → Filter)
**Categoria:** Comportamental
**Onde:**
- Middleware: `CorrelationMiddleware` (`correlation.middleware.ts:11`) aplicado a `forRoutes('*')` em `app.module.ts:34-37` (`AppModule.configure()`).
- Guard: `AdminTokenGuard` (`admin-token.guard.ts:21`, `implements CanActivate`) em `admin.controller.ts:16` (`@UseGuards`).
- Pipe: `ValidationPipe` global (`main.ts:18`).
- Exception Filter: `DomainExceptionFilter` (`domain-exception.filter.ts:36` `@Catch()`, classe l.37) global em `main.ts:21`.

**Por que escolhemos:** cada concern transversal (correlação, autenticação, validação, tradução de erro) é um elo independente do pipeline de request do Nest, executado em ordem e podendo interromper a cadeia.

**Tradeoffs:** ordem de execução implícita pode confundir (ex.: alinhamento do `correlationId` entre pino e o middleware, tratado em `correlation.middleware.ts:15-19`).

**Pontos positivos:** controllers ficam livres de boilerplate de auth/validação/erro; cada elo é testável e reutilizável.

---

### 13. Decorator (metadados declarativos do Nest)
**Categoria:** Estrutural/Comportamental (sabor framework)
**Onde:** uso pervasivo: `@Controller`, `@Post`, `@Get`, `@Body`, `@Headers`, `@Param`, `@HttpCode`, `@UseGuards`, `@Inject`, `@Injectable`, `@Interval(15000)` (`reconcile.scheduler.ts:20`), `@Catch()`, e os decorators de `class-validator`/`@ApiProperty`.

**Por que escolhemos:** é o modelo idiomático do NestJS — anexa metadados (rota, validação, agendamento, DI) declarativamente sem herança ou boilerplate.

**Tradeoffs:** "mágica" via `reflect-metadata`; ordem/escopo de decorators às vezes não óbvios.

**Pontos positivos:** código declarativo e legível; OpenAPI e validação derivam dos mesmos decorators.

---

## Padrões de Resiliência / Confiabilidade

### 14. Idempotência (Idempotency Key + dedupe atômico)
**Categoria:** Comportamental / Confiabilidade
**Onde:** Port `IdempotencyPort.remember()` (`idempotency.port.ts:13-21`). Adapter Redis usa Lua `SET NX PX` + `GET` atômico (`redis-idempotency.adapter.ts:12-16`) para fechar a janela TOCTOU. Adapter in-memory usa seção crítica síncrona (`in-memory-idempotency.adapter.ts:15-23`). No use case, é o **primeiro passo** (`checkout.usecase.ts:83-93`): chave já vista → replay do pedido existente. **Além disso**, o worker é idempotente: ignora pedidos terminais/inexistentes e guarda contra duplo-processamento em `PROCESSING` (`checkout.worker.ts:51-69`).

**Por que escolhemos:** retries de rede e duplo-clique do cliente não podem gerar pedidos/faturamentos duplicados. Idempotência no produtor (chave) e no consumidor (estado terminal/PROCESSING) é defesa em profundidade.

**Tradeoffs:** TTL da chave (`IDEMPOTENCY_TTL_MS`, 24h) precisa ser dimensionado; chave reclamada sem pedido persistido vira `DuplicateRequestError` → 409 (`checkout.usecase.ts:92`), um caso de borda que exige documentação.

**Pontos positivos:** "exactly-once" prático na perspectiva do cliente; tolerância a retry sem efeitos colaterais.

---

### 15. Compensating Transaction (compensação de estoque / sabor Saga)
**Categoria:** Comportamental / Confiabilidade
**Onde:** três pontos de compensação que liberam o estoque reservado:
- Falha durante a reserva multi-item no checkout: libera o que já reservou, no método extraído `reserveItems` (`checkout.usecase.ts:144-150`).
- Worker esgotou tentativas: `onExhausted` → `FAILED` + `stock.release` por item (`checkout.worker.ts:100-123`).
- Reconciliação de PENDING órfão muito antigo: `FAILED` + release (`reconcile.usecase.ts:42-54`).

**Por que escolhemos:** sem transação distribuída entre estoque (Redis) e ERP, a consistência é mantida por compensação: reserva primeiro, libera se o fluxo falhar — evita overselling permanente.

**Tradeoffs:** janela de inconsistência temporária (estoque reservado enquanto o job tenta); se a própria compensação falhar é grave — por isso o BullMQ adapter loga ruidosamente quando `onExhausted` rejeita (`bullmq-queue.adapter.ts:74-80`).

**Pontos positivos:** estoque nunca fica "preso" silenciosamente em pedidos fracassados; consistência eventual garantida.

---

### 16. Retry com Exponential Backoff
**Categoria:** Comportamental / Confiabilidade
**Onde:** BullMQ nativo (`bullmq-queue.adapter.ts:51-56` `attempts` + `backoff: { type: 'exponential' }`) e equivalente in-memory (`in-memory-queue.adapter.ts:52-69` + `ExponentialBackoff`). Configurável via `worker.maxAttempts`/`backoffMs` (`app-config.ts:52-55`).

**Por que escolhemos:** o ERP falha intermitentemente; reentar com espaçamento crescente absorve falhas transitórias sem martelar o ERP.

**Tradeoffs:** aumenta latência até a confirmação; precisa de teto (`maxMs`, `backoff.strategy.ts:19`) para não explodir o delay.

**Pontos positivos:** taxa de sucesso real do checkout sobe sem intervenção; degrada graciosamente para `FAILED` + compensação.

---

### 17. Dead Letter Queue (DLQ lógica)
**Categoria:** Arquitetural / Confiabilidade
**Onde:** BullMQ mantém jobs falhos para inspeção: `removeOnFail: false` (`bullmq-queue.adapter.ts:55`, comentário "logical DLQ"). Jobs esgotados disparam `onExhausted` (compensação), mas permanecem inspecionáveis.

**Por que escolhemos:** falhas definitivas precisam ser auditáveis (por que o pedido falhou?), não silenciosamente descartadas.

**Tradeoffs:** acúmulo de jobs falhos consome memória do Redis; em produção exigiria política de retenção/limpeza.

**Pontos positivos:** observabilidade pós-mortem de pedidos `FAILED`.

---

### 18. Cache-Aside + Single-Flight + Stale-While-Error + TTL Jitter
**Categoria:** Arquitetural / Performance
**Onde:** Port `CachePort.getOrLoad()` (`cache.port.ts:18-23`). A orquestração comum mora na base `AbstractCacheAdapter` (Template Method, ver #9); cada driver fornece só o armazenamento:
- **Cache-aside**: tenta cache; em miss roda `loader`, grava com TTL via `set` (`abstract-cache.adapter.ts:34-37`, `:57-65`).
- **Single-flight**: mapa `inflight` coalesce misses concorrentes na **mesma** chave numa única execução do loader (`abstract-cache.adapter.ts:50-66`) — anti-stampede.
- **Stale-while-error**: se o loader falha e `staleOnError`, serve `lastKnown` (`abstract-cache.adapter.ts:71-76`).
- **TTL jitter**: aplicado na base via `createJitter()` (`abstract-cache.adapter.ts:35`, `cache-jitter.ts`), modelo **proporcional** `[ttl, ttl*(1+ratio)]` com `stampedeJitterRatio` (`app-config.ts`); o `set` repassa o TTL já jitterizado à primitiva `writeStore` do driver. O `ttl()` em `list-products.usecase.ts` passa o TTL puro.
- **Armazenamento por driver**: `InMemoryCacheAdapter` (Map + `expiresAt`, `in-memory-cache.adapter.ts:17-33`) e `RedisCacheAdapter` (JSON + `PX` + evicção de valor corrompido, `redis-cache.adapter.ts:19-38`).
- Uso: `ListProductsUseCase.listAll()` (`list-products.usecase.ts:34-45`).

**Por que escolhemos:** o catálogo é lido com alta frequência e o **repositório de catálogo** simula 40ms de latência (`in-memory-product.repo.ts:22`, modelando uma API síncrona) — distinto do ERP de faturamento, que simula 50–300ms (`ERP_MIN/MAX_LATENCY_MS`, `app-config.ts:58-59`). Cache reduz pressão e latência; single-flight + jitter previnem stampede quando a chave expira sob carga; stale-on-error mantém a vitrine viva se o ERP cair.

**Tradeoffs:** dados podem ficar levemente desatualizados (TTL); single-flight in-process não coordena entre instâncias (o `redis-cache.adapter.ts:5-8` reconhece que precisaria de lock `SET NX` cross-instance).

**Pontos positivos:** menos chamadas ao ERP, latência baixa, resiliência de leitura. Padrão visível nas métricas `cache_requests_total{result=hit|miss|stale}`.

---

### 19. Reconciliation (varredura anti ghost-order)
**Categoria:** Arquitetural / Confiabilidade
**Onde:** `ReconcileUseCase` (`reconcile.usecase.ts:21`) varre `findPendingOlderThan` (`in-memory-order.repo.ts:18-23`): re-enfileira PENDING órfãos (job perdido entre save e enqueue) ou marca `FAILED`+compensa se muito antigos. Disparado por `ReconcileScheduler` (`reconcile.scheduler.ts:20` `@Interval(15000)`) e manualmente via `POST /admin/reconcile` (`admin.controller.ts:15-21`).

**Por que escolhemos:** o checkout salva PENDING **antes** de enfileirar (`checkout.usecase.ts:127-145`); se o `enqueue` falhar, o pedido ficaria órfão. A reconciliação é a rede de segurança que garante progresso.

**Tradeoffs:** varredura periódica custa CPU/IO; cutoffs (`ageMs`/`maxAgeMs`) precisam ser calibrados para não re-enfileirar cedo demais (mitigado pela regra de não voltar de PROCESSING).

**Pontos positivos:** nenhum pedido fica preso em PENDING para sempre; convergência garantida mesmo com falhas parciais.

---

### 20. Outbox (lógico / leve)
**Categoria:** Arquitetural / Confiabilidade
**Onde:** documentado no port (`queue.port.ts:19-24` "The queue acts as a 'logical outbox'") e implementado pela **ordem** em `checkout.usecase.ts:98-112`: salva PENDING (source of truth) → enfileira. Comentário `:108` "If this fails, reconciliation will re-enqueue".

**Por que escolhemos:** garantir que o pedido só seja perdido se a persistência falhar; o enfileiramento é recuperável via reconciliação. É um Outbox "pobre" — sem tabela outbox transacional, mas com o mesmo objetivo (evitar mensagem-fantasma / ghost order).

**Tradeoffs:** não é atômico de verdade (não há transação englobando save+enqueue); confia na reconciliação para fechar a brecha — aceitável dado o requisito de rodar sem banco transacional.

**Pontos positivos:** zero perda silenciosa de pedido com infraestrutura mínima.

---

## Padrões de Domínio / Observabilidade

### 21. Entity, Value Object, Factory Method e funções de domínio puras
**Categoria:** DDD táctico / Criacional
**Onde:** `Order` é a Entity com identidade (`order.ts:25-36`). `ProductView`/`toProductView` (`product.ts:14-30`) é um Value/view object. `tryReserve`/`release` (`stock.ts:13-21`) e `transition` (`order.ts:86`) são funções puras de domínio. `OrderStatus` é enum (`order.ts:3-12`). `DomainError` hierárquico com `code` (`errors.ts:5-47`). **Factory Method de domínio:** `createPendingOrder()` (`order.ts:57-76`) centraliza a forma do "pedido recém-nascido" (status `PENDING`, history seed, `attempts: 0`) no domínio — extraída do literal antes inline no `CheckoutUseCase.run` (refactoring *Move Method*), de modo que o use case agora só invoca a fábrica (`checkout.usecase.ts:99-105`).

**Por que escolhemos:** isolar a regra de negócio (estado válido, reserva, preço em centavos para evitar float — `product.ts:3`, e a construção consistente do agregado `Order`) em código puro, testável sem mocks e independente de infra.

**Tradeoffs:** modelo anêmico em partes (lógica em funções livres em vez de métodos da entidade) — escolha pragmática para TS funcional.

**Pontos positivos:** testes de domínio rápidos e determinísticos (`order.spec.ts`, `stock.ts` exercida em `stock-concurrency.spec.ts`).

---

### 22. Domain Error → HTTP (tradução por Exception Filter)
**Categoria:** Estrutural (anti-corruption na borda)
**Onde:** `DomainError` carrega `code` semântico (`errors.ts:5-13`) e **toda** a hierarquia de erros de domínio o estende — inclusive `DuplicateRequestError` (`errors.ts:44-47`, antes solto em `checkout.usecase.ts` estendendo `Error`; trazido à hierarquia no refactoring). O filter `statusFor()` mapeia tipo de erro → status HTTP (`domain-exception.filter.ts:22-34`): `*NotFound`→404, `InsufficientStock`/`InvalidTransition`/`DuplicateRequest`→409, resto→500. Com todos sendo `DomainError`, o guard do filter virou um único `instanceof DomainError` (`domain-exception.filter.ts:60`), sem ramo especial nem cast frágil.

**Por que escolhemos:** manter o domínio sem conhecer HTTP, centralizando a tradução num único elo do pipeline; e ter uma hierarquia de erros única (`code` + nome) que o filter consome de forma uniforme.

**Tradeoffs:** o filter precisa conhecer os tipos de erro do domínio para o mapeamento de status (acoplamento de mão única, intencional na borda).

**Pontos positivos:** corpo de erro padronizado (`ErrorDto`) com `correlationId` e `timestamp`; domínio limpo.

---

### 23. Ambient Context / Thread-Local (AsyncLocalStorage para correlationId)
**Categoria:** Comportamental
**Onde:** `src/observability/correlation.ts:12` `AsyncLocalStorage<CorrelationStore>`; `runWithCorrelation` propaga em todo o request (middleware, `correlation.middleware.ts:21`) **e** no worker (`checkout.worker.ts:34-48`). Logger e spans leem do contexto (`tracing.service.ts:35` → `startSpan()`, `logger.config.ts:25-27`).

**Por que escolhemos:** propagar `correlationId`/`orderId` por toda a cadeia assíncrona sem passar parâmetro em cada função — traceabilidade ponta a ponta (HTTP → fila → worker → ERP).

**Tradeoffs:** "contexto implícito" pode surpreender; perde-se o contexto se a propagação async quebrar (mitigado por `runWithCorrelation` explícito no worker).

**Pontos positivos:** logs/métricas/spans correlacionados entre request e processamento assíncrono, mesmo após o 202.

---

### 24. Observer (eventos de fila + métricas)
**Categoria:** Comportamental
**Onde:** `this.worker.on('failed', ...)` no BullMQ adapter (`bullmq-queue.adapter.ts:68`) reage ao evento de falha disparando compensação. As métricas (`MetricsService`) funcionam como observadores passivos incrementados ao longo dos fluxos (`checkout.usecase.ts:61`, `checkout.worker.ts:88-119`).

**Por que escolhemos:** desacoplar "o que aconteceu" (job falhou) de "o que fazer" (compensar), via assinatura de evento.

**Tradeoffs:** handlers de evento async precisam tratar rejeição própria (feito em `:74-80`).

**Pontos positivos:** compensação acoplada ao ciclo real de vida do job da lib.

---

### 25. Lua Script como operação atômica (Check-and-Set / anti-TOCTOU)
**Categoria:** Confiabilidade / concorrência
**Onde:** `RESERVE_LUA` (`redis-stock.adapter.ts:13-20`) faz GET+compare+DECRBY atômico no servidor Redis; `REMEMBER_LUA` (`redis-idempotency.adapter.ts:12-16`) faz SET NX + GET atômico. Equivalente in-memory: seção crítica síncrona sem `await` entre leitura e escrita (`in-memory-stock.adapter.ts:21-29`, comentário `:22`).

#### Conceito: por que Lua no Redis

O Redis embute um interpretador **Lua**. Um script enviado via `EVAL` executa
**atomicamente no servidor** — o Redis é single-threaded para execução de comandos, e enquanto
o script roda **nenhum outro comando é intercalado**. Isso transforma uma sequência
"ler → decidir → escrever" em **uma única operação indivisível**, em um único round-trip.

O problema que isso resolve é o **TOCTOU** (*Time-Of-Check to Time-Of-Use*): a janela entre
*checar* um valor e *agir* sobre ele. Nessa janela, outra requisição — possivelmente em **outra
instância da aplicação** — pode alterar o valor, e a decisão passa a se basear em estado
obsoleto. Dois comandos separados (`GET` e depois `DECRBY`) deixam essa janela aberta; o Lua a
fecha porque o check e o write ficam grudados.

Por que não usar `MULTI/EXEC` (transações Redis)? Porque uma transação Redis apenas **enfileira**
comandos e os executa em bloco — ela **não permite lógica condicional baseada no valor lido**
(o `if current < qty`). `WATCH`+`MULTI` (optimistic locking) resolveria, mas exigiria retry no
cliente em caso de contenção. O Lua dá a condicional **e** a atomicidade num passo só, sem
retry.

#### Script 1 — `RESERVE_LUA`: reserva de estoque anti-overselling

```lua
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local qty = tonumber(ARGV[1])
if qty <= 0 then return {0, current} end
if current < qty then return {0, current} end   -- estoque insuficiente → falha
local remaining = redis.call('DECRBY', KEYS[1], qty)
return {1, remaining}
```

- `KEYS[1]` = chave do estoque (`stock:<productId>`); `ARGV[1]` = quantidade pedida.
- **Lê** o saldo, **valida** (`qty > 0` e `current >= qty`) e **só então decrementa** — tudo
  atômico. Retorna `{ok, saldo}`: `{1, restante}` se reservou, `{0, atual}` se recusou.
- **Garantia:** com N instâncias e milhares de requisições simultâneas, é **impossível vender
  mais do que existe**. Sem o Lua, dois pedidos concorrentes poderiam ambos passar no
  `if current < qty` antes de qualquer um decrementar (clássico oversell por corrida).
- O `release` (`redis-stock.adapter.ts:43`) é um `INCRBY` simples — a compensação não precisa de
  check, apenas devolve o saldo.

#### Script 2 — `REMEMBER_LUA`: idempotência sem corrida

```lua
local created = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
local val = redis.call('GET', KEYS[1])
if created then return {1, val} else return {0, val} end
```

- `SET ... NX` grava **só se a chave não existir**; `PX` define TTL em ms. Em seguida o `GET` lê
  o valor efetivo. Retorna `{1, orderId}` se *criou agora* (1ª vez) ou `{0, orderIdExistente}`
  em *replay* (retry de rede / duplo-clique).
- **Por que não `SET NX` e depois `GET` separados?** Como documenta o comentário do código
  (`redis-idempotency.adapter.ts:6-11`): a chave tem TTL e poderia **expirar entre o SET e o
  GET**, fazendo o read-back retornar `nil` e a aplicação devolver o `orderId` errado. O script
  garante que escrita e leitura observem o mesmo instante lógico.

#### Paridade memory ↔ redis

O adapter in-memory atinge a mesma garantia **sem** Lua: ele faz a checagem e a escrita numa
**seção crítica síncrona** (sem `await` entre o `if` e o decremento — `in-memory-stock.adapter.ts:21-29`).
Como o event loop do Node é single-threaded e só troca de tarefa em pontos de `await`, não há
preempção no meio da operação. É o mesmo princípio de atomicidade do Redis (single-thread),
aplicado ao runtime local — por isso os dois adapters são **comportamentalmente equivalentes** e
o teste `stock-concurrency.spec.ts` exercita a propriedade anti-oversell em ambos.

**Por que escolhemos:** reserva de estoque sob concorrência inter-processo é o coração do
"evitar overselling", e idempotência sob retries concorrentes é o coração do "1 pedido por
chave". Lua garante atomicidade real **entre múltiplas instâncias**; o in-memory aproveita o
single-thread do Node para a mesma garantia em processo único.

**Tradeoffs:** lógica de negócio em string Lua não tem type-check do TypeScript nem é coberta
por testes unitários isolados (é validada de ponta a ponta em `stock-concurrency.spec.ts`);
scripts complexos ficam difíceis de manter e debugar; e Lua longo demais pode bloquear o Redis
(aqui os scripts são curtos e O(1), então o bloqueio é desprezível). Há ainda o risco de
*hot key*: como toda reserva do mesmo produto serializa na mesma chave Redis, um SKU
extremamente popular pode virar gargalo (mitigável por sharding de chave em produção).

**Pontos positivos:** overselling e corrida de idempotência **impossíveis por construção**,
mesmo com N instâncias; um único round-trip por operação (menos latência que optimistic locking
com retry); e paridade conceitual memory↔redis que mantém a regra de negócio idêntica nos dois
drivers.

---

## Seção Crítica — Padrões Deliberadamente NÃO Utilizados

Esta seção é o "porquê do que falta". Em cada caso a ausência foi consciente (YAGNI / escopo do desafio) e correta.

### A. ORM / Repository pesado (TypeORM, Prisma) — **não usado**
**Onde caberia:** `OrderRepositoryPort`/`ProductRepositoryPort` poderiam apontar para um banco relacional via ORM.
**Por que NÃO:** o requisito é rodar **sem Docker/banco** para o avaliador. Os repos são `Map` in-memory (`in-memory-order.repo.ts`, `in-memory-product.repo.ts`). O **port** já existe, então trocar por um adapter Postgres/Prisma depois é mecânico, sem reescrever use cases.
**Tradeoffs da decisão:** sem persistência durável (reinício zera pedidos) e sem query real de `findPendingOlderThan` indexada. Aceitável para o escopo; o port preserva o caminho de evolução.

### B. Circuit Breaker completo (Hystrix-style) — **não usado**
**Onde caberia:** envolvendo `ErpPort.invoice()` para abrir o circuito após N falhas.
**Por que NÃO:** já há **retry + backoff exponencial + teto de tentativas + DLQ + compensação** (`checkout.worker.ts`, `bullmq-queue.adapter.ts`). Para um único downstream (ERP fake) num sistema assíncrono onde a fila já absorve falhas, um breaker completo seria redundante e adicionaria estado/configuração sem ganho proporcional. O `staleOnError` do cache já cobre o caminho de leitura.
**Tradeoffs da decisão:** sob falha total e prolongada do ERP, os workers seguem tentando (gastando tentativas) em vez de "abrir" e falhar rápido. Mitigado pelo `maxAttempts` baixo e pela natureza assíncrona. Em produção com ERP real, um breaker seria a próxima adição lógica.

### C. CQRS / Event Sourcing — **não usado**
**Onde caberia:** separar comandos (checkout) de queries (status/catálogo) em modelos distintos; reconstruir estado por eventos.
**Por que NÃO:** o domínio é pequeno e o estado cabe num agregado simples (`Order` com `history[]`). O `history` de transições (`order.ts:29`) já dá auditoria "event-log-like" sem a infraestrutura de ES (event store, projeções, versionamento). CQRS/ES aqui seria over-engineering clássico.
**Tradeoffs da decisão:** sem replay de eventos nem read models otimizados separados; o `history` é um log embutido, não uma fonte de verdade reconstruível. Correto para o tamanho do problema.

### D. Saga Orchestrator / Outbox transacional completo — **versão leve usada**
**Onde caberia:** um coordenador de saga formal e uma tabela outbox transacional (save + enqueue na mesma transação DB).
**Por que NÃO:** sem banco transacional (ver A), uma outbox transacional real é impossível. A solução usa um **outbox lógico** (salvar antes de enfileirar) + **reconciliação** como rede de segurança (`reconcile.usecase.ts`) — a compensação manual (`onExhausted`) cumpre o papel da saga sem um orquestrador dedicado.
**Tradeoffs da decisão:** janela não-atômica entre save e enqueue; depende da reconciliação para fechar. É o trade certo dado "sem Docker".

### E. Distributed Lock cross-instance no cache — **conscientemente parcial**
**Onde caberia:** `SET NX` lock no Redis para single-flight entre **instâncias** (não só in-process).
**Por que NÃO (ainda):** o `RedisCacheAdapter` faz single-flight **in-process** + TTL jitter, e o próprio código documenta que o lock cross-instance seria o próximo passo (`redis-cache.adapter.ts:5-8`). Para a carga do desafio, jitter + coalescing in-process já reduzem o stampede a um nível aceitável.
**Tradeoffs da decisão:** sob N instâncias, até N execuções simultâneas do loader no pior caso (uma por instância) — bem melhor que centenas, mas não 1. Decisão honesta e documentada.

### F. Mapper/Anti-Corruption Layer dedicado (AutoMapper) — **não usado**
**Onde caberia:** biblioteca de mapeamento domínio↔DTO.
**Por que NÃO:** o mapeamento é trivial e manual (`orders.controller.ts:16-26`, `toProductView`). Uma lib de mapper adicionaria dependência e mágica para ganho nulo em objetos tão pequenos. YAGNI.
**Tradeoffs:** mapeamento manual pode divergir se os tipos crescerem; risco baixo no escopo atual.

### G. OpenTelemetry SDK completo — **stub justificado**
**Onde caberia:** exportar spans para um coletor real (Datadog/Jaeger).
**Por que NÃO:** `TracingService` é um tracer custom com API **OTel-compatível** de propósito (`tracing.service.ts:4-12`), para rodar sem subir um coletor. O README documenta como plugar o SDK real via `OTEL_EXPORTER_OTLP_ENDPOINT`.
**Tradeoffs:** spans ficam num buffer em memória (`maxBuffer=1000`), não exportados — suficiente para demonstrar o padrão; swap é direto pela API compatível.

---

## Tabela-Resumo

| # | Padrão | Categoria | Local (evidência) | Benefício principal |
|---|--------|-----------|--------------------|---------------------|
| 1 | Ports & Adapters / Hexagonal | Arquitetural | `application/ports/*`, `infrastructure/**` | Swap memory↔redis sem tocar domínio |
| 2 | Dependency Injection | Arquitetural | `checkout.usecase.ts:46-55` | Testabilidade, baixo acoplamento |
| 3 | Provider/Factory | Criacional | `infrastructure.module.ts:34-97` | Seleção de adapter em runtime |
| 4 | Singleton | Criacional | `metrics.service.ts:10`, `redis.provider.ts` | Recursos compartilhados únicos |
| 5 | Adapter | Estrutural | `bullmq-queue.adapter.ts:13-48` | Isola libs externas dos ports |
| 6 | DTO + validação | Estrutural | `checkout.dto.ts:18-43`, `main.ts:18` | Contrato e 400 automáticos |
| 7 | Facade | Estrutural | `checkout.usecase.ts:57` | Controllers finos |
| 8 | Strategy | Comportamental | `backoff.strategy.ts:9-27` | Backoff reutilizável/testável |
| 9 | Template Method | Comportamental | `in-memory-queue.adapter.ts:52-69`, `abstract-cache.adapter.ts:14` | Esqueleto invariante (retry da fila + getOrLoad do cache) |
| 10 | Producer–Consumer / Command | Comportamental | `checkout.usecase.ts:143`, `checkout.worker.ts:29` | Checkout assíncrono resiliente |
| 11 | State Machine | Comportamental | `order.ts:39-71` | Transições inválidas impossíveis |
| 12 | Chain of Responsibility | Comportamental | middleware/guard/pipe/filter | Concerns transversais isolados |
| 13 | Decorator (Nest) | Estrutural | uso pervasivo | Metadados declarativos |
| 14 | Idempotência | Confiabilidade | `redis-idempotency.adapter.ts:12`, `checkout.usecase.ts:88` | Exactly-once para o cliente |
| 15 | Compensating Transaction | Confiabilidade | `checkout.worker.ts:100-123` | Estoque nunca preso |
| 16 | Retry + Backoff | Confiabilidade | `bullmq-queue.adapter.ts:51`, `backoff.strategy.ts` | Absorve falhas do ERP |
| 17 | Dead Letter Queue | Confiabilidade | `bullmq-queue.adapter.ts:55` | Auditoria de falhas |
| 18 | Cache-Aside (+single-flight/stale/jitter) | Performance | `abstract-cache.adapter.ts`, `cache-jitter.ts` | Baixa latência, anti-stampede |
| 19 | Reconciliation | Confiabilidade | `reconcile.usecase.ts:21` | Sem pedido órfão eterno |
| 20 | Outbox (lógico) | Confiabilidade | `checkout.usecase.ts:127-145` | Sem perda silenciosa de pedido |
| 21 | Entity / VO / Factory Method / funções puras | DDD / Criacional | `order.ts` (`createPendingOrder:57`), `stock.ts`, `product.ts` | Regra testável sem infra; agregado construído de forma consistente |
| 22 | Domain Error → HTTP | Estrutural | `domain-exception.filter.ts:22-34` | Domínio agnóstico de HTTP |
| 23 | Ambient Context (ALS) | Comportamental | `correlation.ts:12` | Traceabilidade ponta a ponta |
| 24 | Observer | Comportamental | `bullmq-queue.adapter.ts:68` | Reação desacoplada a eventos |
| 25 | Lua atomic CAS | Concorrência | `redis-stock.adapter.ts:13`, `redis-idempotency.adapter.ts:12` | Anti-overselling/TOCTOU |

---

## Conclusão — Coerência Arquitetural

O projeto demonstra **coerência arquitetural forte e intencional**. O fio condutor é o par **Hexagonal + DI**: cada capacidade de infra (cache, estoque, fila, idempotência, repo, ERP) é um *port* com duas implementações (in-memory e Redis/BullMQ), selecionadas por *factory* em runtime. Isso atende diretamente ao requisito do desafio (rodar sem Docker **e** com Redis) sem nenhuma duplicação de lógica de negócio.

Sobre essa base, os padrões de **confiabilidade** formam um conjunto bem articulado e não-redundante para o problema real (checkout assíncrono contra um ERP lento/instável): **idempotência** na borda e no worker, **reserva atômica** (Lua/single-thread) anti-overselling, **retry+backoff** compartilhado via Strategy, **compensação** em três pontos, **outbox lógico + reconciliação** como rede de segurança, e **DLQ** para auditoria. A **observabilidade** (ALS para correlationId, métricas Prometheus, tracing OTel-compatível) atravessa o request e o processamento assíncrono de forma consistente.

Igualmente importante é o que **não** foi feito: ausência de ORM, Circuit Breaker completo, CQRS/Event Sourcing, Saga orquestrada e OTel real são omissões **conscientes e justificadas** pelo escopo (sem banco/Docker) e por já existirem mecanismos equivalentes ou suficientes — evitando over-engineering. Os pontos onde a solução é deliberadamente parcial (single-flight in-process vs lock cross-instance; outbox lógico vs transacional; tracer stub) estão **documentados no próprio código**, com o caminho de evolução preservado pelos ports. É exatamente o equilíbrio que se espera de uma arquitetura madura: resolver o problema presente com os padrões certos, sem pagar pela complexidade de problemas que ainda não se tem.
