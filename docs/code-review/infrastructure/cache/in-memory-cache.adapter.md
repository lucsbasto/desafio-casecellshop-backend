# Code Review — src/infrastructure/cache/in-memory-cache.adapter.ts

## Resumo

Adapter de cache em memória que implementa `CachePort` com TTL, single-flight (anti-stampede) e fallback stale-while-error. A lógica de coalescência e o caminho feliz estão corretos e bem alinhados ao port; o teste cobre os quatro comportamentos centrais. Os problemas reais são de **gestão de memória (crescimento ilimitado dos `Map`)**, **inconsistência de `del()` com `inflight`/`lastKnown`** e **aliasing de referências mutáveis**. Nenhum bug crítico de corrupção, mas há riscos de vazamento de memória e de servir dados deletados como "stale".

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 2 |
| MEDIUM     | 3 |
| LOW        | 4 |

---

## HIGH

### H1 — Crescimento ilimitado de `store` e `lastKnown` (vazamento de memória)
- **Local:** linhas 14, 17, 30–31; eviction só em `get()` (linhas 22–24).
- **Descrição:** Não há limite de tamanho (LRU/cap) nem varredura periódica. Entradas expiradas em `store` só são removidas **preguiçosamente** quando a *mesma* chave é lida de novo (linha 23); chaves que expiram e nunca mais são lidas permanecem para sempre. Pior: `lastKnown` (linha 17) **nunca é removido em lugar nenhum** — cada chave já vista mantém seu último valor vivo indefinidamente.
- **Impacto:** Em um catálogo onde as chaves são `products:${id}` (ver `list-products.usecase.ts:11`), o número de chaves distintas é limitado; mas qualquer key-space dinâmico (filtros, paginação, ids efêmeros) faz a memória do processo crescer monotonicamente até OOM. Para um adapter que se anuncia como "in-memory", a ausência de cota é a falha mais séria.
- **Correção sugerida:** Introduzir um limite máximo de entradas com política de eviction (LRU simples ou descarte do mais antigo), e/ou um sweep periódico de expirados. `lastKnown` precisa de cota própria (ou ser consolidado em `store` com flag de "expirado mas retido"). Exemplo mínimo de cap em `set`:
  ```ts
  private readonly maxEntries = 10_000;
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value; // Map preserva ordem de inserção
      if (oldest !== undefined) { this.store.delete(oldest); this.lastKnown.delete(oldest); }
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.lastKnown.set(key, value);
  }
  ```

### H2 — `del()` não limpa `inflight` nem `lastKnown` (invalidação incompleta)
- **Local:** linhas 34–36.
- **Descrição:** `del(key)` remove apenas de `store`. Consequências: (a) se há um loader **em voo** para a chave (`inflight`), ele ainda concluirá e fará `set()` (linha 59), **repopulando** a chave que acabou de ser invalidada — `del` perde a corrida silenciosamente; (b) `lastKnown` mantém o valor antigo, então um `getOrLoad(..., { staleOnError: true })` posterior pode servir como "stale" exatamente o dado que o chamador pediu para apagar.
- **Impacto:** Invalidação de cache não confiável. Em e-commerce, se um produto é despublicado/atualizado e `del` é chamado para forçar releitura, o sistema pode continuar servindo o valor antigo (via repopulação por loader em voo ou via fallback stale). Quebra a expectativa semântica de `del`.
- **Correção sugerida:** Apagar das três estruturas e, opcionalmente, abortar a coalescência:
  ```ts
  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.lastKnown.delete(key);
    this.inflight.delete(key); // futuros callers não reusarão o loader stale; o set() do loader em voo
                               // ainda pode repopular — documentar ou usar epoch/token para invalidar.
  }
  ```
  Se a corrida com o loader em voo precisar ser vencida de forma determinística, adotar um contador de "epoch" por chave e descartar o `set` cujo epoch ficou obsoleto.

---

## MEDIUM

### M1 — Aliasing: valores são armazenados e devolvidos por referência (mutação compartilhada)
- **Local:** linhas 26, 30–31, 73 (sem clone em nenhum ponto).
- **Descrição:** `get`/`getOrLoad` devolvem a **mesma referência** guardada em `store`/`lastKnown`. Se qualquer chamador mutar o objeto/array retornado, ele muta o conteúdo cacheado (e o `lastKnown`) para todos os próximos leitores. Diferente do `RedisCacheAdapter`, que serializa via `JSON.stringify`/`parse` e portanto entrega cópias independentes — ou seja, os dois adapters têm semântica de isolamento divergente sob o mesmo `CachePort`.
- **Impacto:** Bug latente e dependente do comportamento do chamador. Hoje `ListProductsUseCase` mapeia com `toProductView` antes de expor (não muta a referência), então não há bug ativo; mas é uma armadilha para qualquer consumidor futuro e uma divergência de comportamento In-Memory vs Redis que pode mascarar bugs até a troca de driver.
- **Correção sugerida:** Documentar explicitamente o contrato (caller não deve mutar o retorno) **ou** clonar na escrita/leitura (`structuredClone`) para igualar a semântica do Redis. Clonar tem custo; no mínimo, deixar a invariante explícita no `CachePort`.

### M2 — `ttlMs` não é validado/clampeado (entrada já expirada e divergência com Redis)
- **Local:** linha 30 (`Date.now() + ttlMs`).
- **Descrição:** `set` aceita qualquer `number`. Com `ttlMs <= 0` (ou `NaN`), `expiresAt` fica `<= Date.now()` (ou `NaN`), e `get` (linha 22, `<=`) trata como expirado imediatamente — o `getOrLoad` grava e a entrada já nasce inútil, executando o loader em toda chamada. O `RedisCacheAdapter` defende com `Math.max(1, ttlMs)` (linha 29); aqui não há clamp, criando comportamento divergente entre drivers.
- **Impacto:** Um TTL mal configurado (ex.: jitter/config zerada) desliga silenciosamente o cache sem erro, com impacto de carga no ERP. `NaN` é especialmente insidioso porque `NaN <= Date.now()` é `false`, então a entrada **nunca** expira — o oposto do esperado.
- **Correção sugerida:** Validar/clampear na entrada, espelhando o Redis: `const safeTtl = Number.isFinite(ttlMs) ? Math.max(1, ttlMs) : 1;` e usar `safeTtl`. Idealmente mover essa regra para o port/contrato para garantir paridade entre adapters.

### M3 — Rótulo `hit: true` para waiters coalescidos é semanticamente enganoso
- **Local:** linhas 51–54 (e simetricamente 72–73 retorna `hit: false` no fallback).
- **Descrição:** Quando uma chamada concorrente reusa um loader em voo (single-flight), o resultado é rotulado `hit: true`, mas tecnicamente foi um **miss coalescido** — o valor veio da execução do loader, não do cache. O `ListProductsUseCase` incrementa a métrica `cacheRequests{result}` com base nesse flag (`list-products.usecase.ts:43,54`), então N-1 misses concorrentes serão contados como `hit`.
- **Impacto:** Distorce as métricas de hit-rate de cache justamente sob carga (stampede), que é quando o número importa para capacity planning. Não afeta correção funcional.
- **Correção sugerida:** Decidir conscientemente a semântica e documentá-la, ou introduzir um terceiro estado (ex.: `coalesced: true` / `hit: false`) para que a observabilidade reflita a realidade. Garantir paridade com o `RedisCacheAdapter`, que tem o mesmo rótulo.

---

## LOW

### L1 — `as T` repetido sobre valores de tipo apagado (type assertions inseguras)
- **Local:** linhas 26, 52, 68, 73.
- **Descrição:** `store`/`inflight`/`lastKnown` guardam `unknown`; o tipo `T` é recuperado por asserção. Se dois chamadores usarem a mesma chave com `T` diferentes, a asserção é unsound e nenhum erro é levantado. É uma limitação inerente ao desenho do `CachePort` (chave string opaca, T por chamada), não um defeito local.
- **Impacto:** Baixo na prática (chaves namespaced por convenção), mas remove garantias do compilador.
- **Correção sugerida:** Aceitável como está; documentar a invariante "uma chave, um tipo". Não vale complexidade adicional.

### L2 — Stale sem limite de idade máxima
- **Local:** linhas 72–73.
- **Descrição:** O fallback serve `lastKnown` independentemente de quão antigo é o valor. Combinado com H1 (lastKnown nunca expira), pode-se servir dado arbitrariamente velho como "stale".
- **Impacto:** Em falha prolongada do ERP, o storefront pode mostrar preço/estoque muito desatualizados sem teto de tolerância. Mitigado pelo flag `stale: true` propagado à métrica, mas sem corte duro.
- **Correção sugerida:** Opcionalmente registrar `staleSince`/idade no `lastKnown` e respeitar um `maxStaleMs` (descartar fallback além do limite). Decisão de produto.

### L3 — `get`/`set`/`del` são `async` sem necessidade
- **Local:** linhas 19, 29, 34.
- **Descrição:** As operações são puramente síncronas (Map em memória) mas retornam `Promise`. É **correto e necessário** para honrar o `CachePort` (que o Redis implementa de forma genuinamente assíncrona); citado apenas para registro. Cada chamada aloca uma microtask desnecessária.
- **Impacto:** Negligenciável.
- **Correção sugerida:** Manter como está — a uniformidade do port supera o micro-custo. Sem ação.

### L4 — Ausência de `@Injectable()` (apenas nota de idiomatismo NestJS)
- **Local:** linha 13.
- **Descrição:** A classe não tem `@Injectable()`. Isso é **correto** aqui porque ela é instanciada via `useFactory` em `infrastructure.module.ts:34-41` (`new InMemoryCacheAdapter()`), sem injeção de dependências no construtor — o decorator seria inócuo.
- **Impacto:** Nenhum. Registrado só para deixar explícito que a ausência é intencional/correta.
- **Correção sugerida:** Nenhuma ação.

---

## Pontos positivos

- **Single-flight correto:** o `finally` (linhas 61–63) limpa `inflight` antes de qualquer caminho de retorno, e waiters concorrentes reusam a mesma `Promise` (linhas 50–54). O teste de 20 chamadas concorrentes confirma `loads === 1`.
- **Ordem de operações sólida:** verificação de cache → reuso de inflight → criação do loader, com registro em `inflight` (linha 65) imediatamente após criar a promise; sem janela de double-load detectável no fluxo single-threaded do event loop.
- **Fallback stale isolado por flag** (`opts.staleOnError`) e só quando `lastKnown.has(key)` — não inventa valores; re-lança o erro original preservando a stack (linha 75) quando não há fallback.
- **Eviction lazy de expirados em `get`** (linhas 22–24) evita devolver valor vencido.
- **Paridade estrutural com `RedisCacheAdapter`:** a lógica de `getOrLoad` é praticamente idêntica, o que facilita troca de driver e raciocínio. (As divergências de M1/M2 são justamente onde a paridade quebra e merecem atenção.)
- **Aderência hexagonal correta:** implementa um port da camada de aplicação, sem vazar tipos de infra para o domínio; não há acoplamento indevido.
- **Tipagem do `Entry<T>` clara** e uso de `readonly` nos campos privados.

---

## Veredito

**Aprovado com ressalvas.**

Não há bug crítico de correção no caminho feliz nem no single-flight, e o adapter é adequado para o cenário atual (key-space limitado a `products:*`). Porém, antes de qualquer uso com key-space dinâmico ou alta longevidade do processo, **H1 (memória ilimitada)** e **H2 (del incompleto)** devem ser corrigidos — são os dois itens que podem causar incidente em produção (OOM e invalidação não confiável). M1–M3 são divergências de semântica entre os adapters In-Memory e Redis sob o mesmo port; recomenda-se alinhá-las para evitar bugs que só aparecem ao trocar de driver.
