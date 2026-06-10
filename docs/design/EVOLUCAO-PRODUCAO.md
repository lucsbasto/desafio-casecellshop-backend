# Evolução para Produção — Dívidas Conscientes

> Este documento registra, de forma honesta, **o que foi deliberadamente simplificado** neste
> projeto e **como evoluir cada ponto** num produto real com o mesmo propósito (backend de
> e-commerce: catálogo + checkout assíncrono contra um ERP lento/instável).
>
> Cada item segue o mesmo formato: **Decisão atual → Por quê → Quando quebra → O que adicionar
> em produção → Como medir**. Nenhum item é um erro arquitetural; são dívidas técnicas
> conscientes, baratas de pagar depois porque os *ports* já isolam o ponto de mudança.
>
> Relacionado: [`../DESIGN-PATTERNS.md`](../DESIGN-PATTERNS.md) (seção crítica "Padrões
> deliberadamente NÃO utilizados"), [`ACCURACY-CHECK.md`](./ACCURACY-CHECK.md).

---

## 1. Cache-Aside (#18) — Single-Flight, Stale-While-Error e TTL Jitter

**Onde:** `src/application/ports/cache.port.ts` (`getOrLoad()`), `infrastructure/cache/redis-cache.adapter.ts`, `infrastructure/cache/in-memory-cache.adapter.ts`, `application/use-cases/list-products.usecase.ts` (`ttl()` com jitter).

### Decisão atual

O catálogo é servido via **cache-aside** com três proteções: **single-flight** (coalescing de
misses concorrentes na mesma chave dentro do processo), **stale-while-error** (serve o último
valor conhecido se o loader falhar) e **TTL + jitter** (espalha as expirações para evitar pico
sincronizado). A invalidação é puramente por expiração de TTL.

### Por que acredito que essa escolha é a mais correta para o escopo

O ponto mais importante é **onde** o sistema tolera inconsistência:

- A staleness afeta **apenas a vitrine** (listagem/detalhe de produto). Preço e disponibilidade
  exibidos no browse mudam devagar, e a UX de navegação tolera *eventual consistency*.
- **O checkout NÃO lê do cache.** A reserva de estoque é feita atomicamente via script Lua no
  Redis (`RESERVE_LUA` em `redis-stock.adapter.ts`), furando o cache por design. Ou seja, o
  único caminho onde dado stale seria perigoso (a compra) já não depende do cache. Essa
  separação é a decisão de design que torna a staleness do catálogo segura.
- **Stale-while-error** é resiliência madura: a loja continua navegável durante uma queda do
  ERP, em vez de retornar erro ao cliente.
- **TTL jitter** é boa prática real (não simplificação): evita que muitas chaves expirem juntas
  e gerem um pico coordenado de carga no ERP.

### Tradeoffs aceitos

1. **Dados levemente desatualizados** (limitado pelo TTL) — aceitável na vitrine, conforme acima.
2. **Single-flight é só in-process** — não coordena entre instâncias.

### Quando quebra (limites em produção)

- **Single-flight in-process:** com **N instâncias**, no pior caso há **N execuções
  simultâneas do loader por chave** quando o TTL expira (uma por réplica), não 1. Para um ERP
  lento, sob tráfego alto + muitas réplicas + chave quente, isso pode gerar um *thundering herd
  entre instâncias* nas bordas de expiração. O jitter atenua, mas **não deduplica entre
  processos**.
- **Invalidação só por TTL:** aqui o catálogo é read-only, então TTL basta. Num produto real
  **com edição de produto/preço**, esperar o TTL expirar significa exibir preço errado por até
  `ttl` segundos após uma alteração.

### O que adicionar em produção

- **Single-flight cross-instance:** lock distribuído `SET NX` no Redis (o próprio código já
  aponta isso em `redis-cache.adapter.ts:5-8`) **ou**, preferível, migrar para
  **stale-while-revalidate** — servir o valor stale imediatamente e revalidar em background.
  Isso elimina a latência de cauda no miss e reduz a pressão coordenada sobre o ERP.
- **Invalidação ativa:** ao escrever/atualizar um produto, fazer *evict* ou *publish* da chave
  (em vez de só esperar o TTL). Alternativa: TTL curto + revalidação proativa.
- **Negative caching:** cachear respostas 404 (produto inexistente) por um TTL curto, para não
  martelar o ERP com buscas repetidas de IDs inválidos.

### Como medir (decidir com dados, não achismo)

A métrica `cache_requests_total{result=hit|miss|stale}` já existe
(`observability/metrics.service.ts`). Com ela é possível acompanhar **hit ratio** e **taxa de
stale** em produção e disparar a evolução acima no momento certo — por exemplo, quando o
volume de `miss` concorrente por chave passar a impactar a latência do ERP, ou quando a taxa de
`stale` indicar que o ERP está instável com frequência.

### Veredito

Para o escopo deste projeto, acredito que a estratégia atual atende bem: ela resolve o
stampede no caminho que importa e mantém a loja navegável quando o ERP oscila.

Num produto real, o caminho de evolução que eu seguiria é direto: quando passarmos de 2–3
réplicas, levar o single-flight para o nível distribuído (lock `SET NX` ou
stale-while-revalidate); e assim que o catálogo deixar de ser somente leitura, adicionar
invalidação ativa e negative caching. São passos incrementais, não uma reescrita — o port de
cache já isola exatamente esse ponto de mudança.

---

## 2. Circuit Breaker completo (Hystrix-style)

**Onde caberia:** envolvendo `ErpPort.invoice()` (`application/ports/erp.port.ts`,
`infrastructure/erp/fake-erp.client.ts`).

### Decisão atual

**Não implementado.** A resiliência contra o ERP é feita com **retry + backoff exponencial +
teto de tentativas + DLQ lógica + compensação de estoque** (`checkout.worker.ts`,
`bullmq-queue.adapter.ts`).

### Por que acredito que essa escolha é a mais correta para o escopo

Para um **único downstream** num fluxo **assíncrono** onde a fila já absorve falhas, um breaker
completo seria redundante e adicionaria estado/configuração (janela, half-open, thresholds) sem
ganho proporcional. O `staleOnError` do cache já cobre o caminho de **leitura**.

### Quando quebra

Sob **falha total e prolongada** do ERP, os workers continuam consumindo tentativas (retry +
backoff) por job em vez de "abrir" o circuito e falhar rápido — desperdiçando trabalho e
atrasando o `FAILED` definitivo.

### O que adicionar em produção

Um **circuit breaker** em volta do `FakeErpClient`/cliente real: após N falhas numa janela,
abrir o circuito e curto-circuitar as chamadas (falhar rápido → `FAILED` + compensação), com
estado *half-open* para sondar recuperação. Em produção com ERP real, é a **próxima adição
lógica**. Mitigação atual: `maxAttempts` baixo + natureza assíncrona já limitam o estrago.

---

## 3. Lock distribuído cross-instance (cache e refresh)

**Onde caberia:** `RedisCacheAdapter` (single-flight entre instâncias) — ver também item 1.

### Decisão atual

Single-flight **in-process** + TTL jitter. O código documenta explicitamente que o lock
cross-instance seria o próximo passo (`redis-cache.adapter.ts:5-8`).

### Por que / Quando quebra / O que adicionar

Coberto em detalhe no **item 1** (é a mesma dívida, vista pela ótica de concorrência
distribuída). Resumo: para a carga do desafio, jitter + coalescing in-process reduzem o
stampede a um nível aceitável; sob muitas réplicas, adicionar `SET NX` lock ou
stale-while-revalidate.

---

## 4. OpenTelemetry SDK real

**Onde caberia:** `observability/tracing.service.ts` (hoje um tracer custom com API
OTel-compatível, marcado como "JUSTIFIED STUB").

### Decisão atual

`TracingService` é um tracer próprio com API **compatível com OTel** de propósito, com buffer
em memória (`maxBuffer = 1000`). Não exporta spans para um coletor.

### Por que acredito que essa escolha é a mais correta para o escopo

Permite demonstrar o padrão de tracing (spans, correlationId via `AsyncLocalStorage`) e rodar
**sem subir um coletor** (Jaeger/Datadog/OTLP), coerente com o requisito "sem Docker".

### Quando quebra

Em produção, spans num buffer em memória não dão observabilidade distribuída real (sem
correlação entre serviços, sem retenção, sem visualização).

### O que adicionar em produção

Plugar o **OpenTelemetry SDK** real e exportar via OTLP (`OTEL_EXPORTER_OTLP_ENDPOINT`, já
mencionado no README). Como a API atual já é OTel-compatível, o swap é direto — trocar a
implementação do `TracingService` sem tocar nos pontos de instrumentação.

---

## 5. Persistência durável (ORM / banco real)

**Onde caberia:** `OrderRepositoryPort` / `ProductRepositoryPort`
(`application/ports/repository.port.ts`), hoje `Map` in-memory.

### Decisão atual

Repositórios **in-memory** (`infrastructure/repo/*`). O **port** já existe.

### Por que acredito que essa escolha é a mais correta para o escopo

O requisito é rodar **sem Docker/banco** para o avaliador. Com o port definido, trocar por um
adapter Postgres/Prisma é mecânico, sem reescrever use cases.

### Quando quebra

Sem persistência durável: **reinício zera pedidos**; `findPendingOlderThan` é uma varredura
linear (não uma query indexada).

### O que adicionar em produção

Adapter de repositório sobre Postgres (índice em `status`+`createdAt` para a reconciliação).
Com banco transacional, abre-se também a porta para o **item 6**.

---

## 6. Outbox transacional / Saga orquestrada

**Onde caberia:** coordenação `save(Order)` + `enqueue(job)` numa transação; coordenador de
saga formal.

### Decisão atual

**Outbox lógico** (salva `PENDING` antes de enfileirar) + **reconciliação** como rede de
segurança (`reconcile.usecase.ts`), e **compensação manual** (`onExhausted`) no lugar de um
orquestrador de saga.

### Por que acredito que essa escolha é a mais correta para o escopo

Sem banco transacional (item 5), uma outbox transacional real é impossível. O outbox lógico +
reconciliação fecham a brecha de "pedido órfão" com infraestrutura mínima.

### Quando quebra

Há uma **janela não-atômica** entre `save` e `enqueue`; o sistema depende da reconciliação
periódica (`@Interval(15000)`) para fechá-la. Aceitável, mas significa latência até a
recuperação de um job perdido.

### O que adicionar em produção

Com banco transacional: **tabela outbox** gravada na mesma transação do pedido, com um relay
publicando para a fila (exactly-once efetivo). Para fluxos multi-etapa mais complexos, um
**coordenador de saga** explícito com passos e compensações declarados.

---

## 7. Mapper / Anti-Corruption Layer dedicado

**Onde caberia:** mapeamento domínio ↔ DTO (`orders.controller.ts`, `toProductView`).

### Decisão atual

Mapeamento **manual e trivial**, sem biblioteca (AutoMapper etc.).

### Por que / Quando quebra / O que adicionar

YAGNI: os objetos são pequenos; uma lib de mapper adicionaria dependência e mágica para ganho
nulo. **Quando quebra:** se os tipos crescerem muito e o mapeamento manual começar a divergir/
duplicar. **O que adicionar:** uma camada de mapeamento explícita (funções puras de map por
agregado) antes de uma lib — só introduzir AutoMapper se a repetição justificar.

---

## Tabela-resumo

| # | Dívida consciente | Mitigação atual | Gatilho para evoluir | Próximo passo |
|---|---|---|---|---|
| 1 | Single-flight só in-process | jitter + coalescing in-process | muitas réplicas + ERP frágil | `SET NX` lock ou stale-while-revalidate |
| 1 | Invalidação só por TTL | TTL curto | escrita no catálogo | invalidação ativa + negative caching |
| 2 | Sem Circuit Breaker | retry+backoff+DLQ+compensação | falha prolongada do ERP | breaker em `ErpPort.invoice()` |
| 3 | Sem lock distribuído | (= item 1) | escala horizontal | lock Redis / refresh em background |
| 4 | Tracing é stub OTel-compatível | buffer em memória | precisar de traces distribuídos | OTel SDK + OTLP exporter |
| 5 | Repos in-memory | port já isolado | precisar de durabilidade | adapter Postgres/Prisma |
| 6 | Outbox lógico (não transacional) | save-antes-enqueue + reconciliação | precisar de exactly-once forte | outbox transacional / saga |
| 7 | Mapeamento manual | objetos pequenos | tipos crescerem | camada de map explícita |

## Princípio comum

Todas as dívidas acima compartilham a mesma propriedade: **o ponto de mudança já está isolado
por um port ou por uma API compatível**. Isso é intencional — a arquitetura hexagonal permite
pagar cada dívida trocando uma implementação, sem reescrever regra de negócio. Resolver o
problema presente com os padrões certos, sem pagar antecipadamente pela complexidade de
problemas que ainda não existem.
