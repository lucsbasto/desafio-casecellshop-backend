# Code Review — src/application/ports/cache.port.ts

Arquivo de **contrato** (port da arquitetura hexagonal): um `Symbol` de injeção e a interface `CachePort` (cache-aside com single-flight e stale-while-error). Não há lógica executável, então a maioria dos achados é sobre **subespecificação do contrato** e ambiguidades de tipo que se propagam para os adapters (`RedisCacheAdapter`, `InMemoryCacheAdapter`) e para o consumidor (`ListProductsUseCase`). O arquivo é limpo e bem documentado, mas o contrato deixa decisões críticas implícitas.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 2          |
| MEDIUM     | 4          |
| LOW        | 3          |

---

## HIGH

### H1 — `get`/`getOrLoad` usam `undefined` como sentinela de "miss", colidindo com valores legítimos `undefined`/`null`
- **Local:** linhas 8, 18-23
- **Descrição:** `get<T>` retorna `Promise<T | undefined>`, e em `getOrLoad` o teste de hit (nos adapters) é `cached !== undefined`. Não há nada no contrato que impeça `T` de ser `undefined` ou um valor cujo cache legítimo seja "vazio". Pior: o consumidor `ListProductsUseCase.getById` (linhas 47-55) carrega via `repo.findById(id)` que retorna `Product | undefined`. Quando o produto não existe, o loader devolve `undefined`, o adapter o serializa/armazena, mas em chamadas seguintes `get` retorna `undefined` e é interpretado como **miss** — o cache nunca "pega" para o caso "produto inexistente".
- **Impacto:** Para chaves cujo valor correto é ausência (negative caching), o single-flight e o TTL são anulados: toda requisição re-executa o loader (re-bate no "ERP"), exatamente o cenário de stampede que o port promete mitigar. É também uma inconsistência semântica silenciosa: o contrato não distingue "não está em cache" de "cacheado como undefined".
- **Correção sugerida:** Decidir e documentar explicitamente a semântica. Opção robusta: introduzir um sentinela de ausência distinto de `undefined`, e/ou restringir o tipo para proibir `undefined` como valor de cache:
  ```ts
  // Proíbe armazenar undefined/null como valor (força negative caching explícito).
  set<T>(key: string, value: NonNullable<T>, ttlMs: number): Promise<void>;
  ```
  No mínimo, adicionar ao docstring: "`undefined` significa AUSÊNCIA; não armazene `undefined`. Para negative caching, encapsule (ex.: `{ found: false }`)."

### H2 — Contrato silencioso sobre o comportamento de `getOrLoad` quando o loader falha e NÃO há valor stale
- **Local:** linhas 16, 18-23
- **Descrição:** O docstring diz "if true and the loader fails, serves the last stale value (fallback)", mas não define o que acontece quando `staleOnError` é `true` e não existe valor anterior, nem o que acontece quando `staleOnError` é `false`/omisso. Os adapters fazem `throw err` (rethrow), o que é razoável — mas isso é uma decisão de implementação que o contrato deveria fixar. Um segundo adapter poderia, por exemplo, retornar `{ value: undefined, stale: true }` e o consumidor (`listAll` → `value.map(...)`, linha 44) quebraria com `TypeError`.
- **Impacto:** O tipo de retorno `{ value: T; ... }` mente: em caminho de erro sem stale, não há `T` para retornar. O contrato não documenta que `getOrLoad` **rejeita** nesse caso, então consumidores não sabem que precisam de `try/catch`. Risco de `value` ser `undefined` mascarado como `T` e causar 500 a jusante.
- **Correção sugerida:** Documentar explicitamente o contrato de falha no JSDoc:
  ```
  * Se o loader falhar:
  *  - staleOnError=true E existe valor anterior → resolve com { stale: true }.
  *  - caso contrário → REJEITA com o erro do loader (não resolve com value indefinido).
  ```

---

## MEDIUM

### M1 — Semântica de `hit` indefinida para chamadas coalescidas (single-flight)
- **Local:** linhas 12-15, 23 (campo `hit`)
- **Descrição:** O contrato não define o valor de `hit` para um chamador que apenas *aderiu* a um loader em andamento. Ambos os adapters retornam `hit: true` para o caso coalescido (`redis-cache.adapter.ts:47`, `in-memory-cache.adapter.ts:52-53`), embora seja conceitualmente um **miss compartilhado**, não um hit de cache.
- **Impacto:** O consumidor usa `hit` diretamente para métricas (`list-products.usecase.ts:43,54`: `result: hit ? 'hit' : 'miss'`). Chamadas coalescidas são contadas como `hit`, inflando a taxa de acerto do cache e poluindo o sinal de observabilidade (que é um objetivo declarado do projeto). Como o contrato não fixa isso, dois adapters poderiam divergir.
- **Correção sugerida:** Definir no docstring o significado dos três estados e, se desejado, separar coalescência de hit real (ex.: `hit: boolean` = veio do store; adicionar `coalesced?: boolean`), ou documentar claramente "coalesced loaders contam como hit".

### M2 — Ausência de restrição de serializabilidade em `T` apesar de adapter usar JSON
- **Local:** linhas 8-9, 18-23
- **Descrição:** O contrato é genérico em `T` sem qualquer limite. O `RedisCacheAdapter` faz `JSON.stringify`/`JSON.parse` (linhas 19, 29). Tipos do domínio que contenham `Date`, `Map`, `Set`, `bigint`, `undefined` em campos, ou métodos serão silenciosamente corrompidos (ex.: `Date` vira `string`; campos `undefined` somem) ao passar pelo Redis, mas NÃO pelo `InMemoryCacheAdapter` (que guarda a referência viva).
- **Impacto:** Comportamento divergente entre adapters para o mesmo contrato — um bug clássico de "funciona em teste (in-memory), quebra em produção (Redis)". `Product`/`ProductView` hoje parecem planos, mas nada no contrato protege contra regressão futura.
- **Correção sugerida:** Documentar a exigência ("valores devem ser JSON-serializáveis e round-trippable") e, idealmente, tipar: `set<T extends JsonSerializable>(...)`. No mínimo, um comentário de contrato alertando sobre `Date`/`Map`.

### M3 — Relação entre `del` e o valor stale (`lastKnown`) não especificada
- **Local:** linha 10
- **Descrição:** O contrato de `del` diz apenas "remove a chave". Não diz se o valor de fallback stale também é descartado. Nos dois adapters, `del` remove do `store`/Redis mas **não** limpa `lastKnown`. Logo, após `del('k')`, se uma chamada `getOrLoad('k', ..., { staleOnError: true })` falhar no loader, o adapter ainda serve o valor antigo "deletado".
- **Impacto:** Em cenários de invalidação intencional (ex.: produto removido/alterado no ERP), o sistema pode reviver dado obsoleto sob falha do loader, contrariando a intenção do `del`. É um vazamento de estado sutil que o contrato não disciplina nem proíbe.
- **Correção sugerida:** Decidir a política e documentá-la: "`del` invalida também o valor stale-fallback" (recomendado) ou explicitar que não. Se "sim", o contrato deve obrigar os adapters a limpar `lastKnown` em `del`.

### M4 — Sem contrato de timeout/cancelamento para o loader sob single-flight
- **Local:** linhas 18-23
- **Descrição:** Como callers concorrentes compartilham UMA execução do loader, um loader lento ou pendurado bloqueia todos os aderentes pelo tempo que durar. O contrato não menciona timeout, `AbortSignal`, nem limite de espera.
- **Impacto:** Num pico (a "hot key" do teste), uma chamada lenta ao "ERP" propaga latência para todos os coalescidos simultaneamente; sem timeout, isso pode esgotar o pool de requisições HTTP. Relevante para um checkout sob carga.
- **Correção sugerida:** Adicionar ao contrato um parâmetro opcional (ex.: `opts.loaderTimeoutMs?` ou `signal?: AbortSignal`) e documentar a garantia de propagação de erro/timeout aos aderentes, ou ao menos documentar explicitamente que não há timeout (decisão consciente).

---

## LOW

### L1 — Ordem dos parâmetros: `ttlMs` antes do `loader` é menos idiomático
- **Local:** linhas 18-21
- **Descrição:** A assinatura é `(key, ttlMs, loader, opts)`. A convenção usual de `getOrLoad`/`memoize` coloca a função primeiro (`(key, loader, opts)`) com TTL em `opts`. Colocar o número solto entre a chave e a função reduz legibilidade no call-site.
- **Impacto:** Cosmético/manutenção; risco baixo de troca acidental de argumentos já que os tipos diferem.
- **Correção sugerida:** Considerar `getOrLoad<T>(key, loader, opts: { ttlMs: number; staleOnError?: boolean })`. Mudança de API — avaliar custo/benefício.

### L2 — `ttlMs` sem validação documentada de domínio (negativo/zero)
- **Local:** linhas 9, 19
- **Descrição:** O contrato aceita qualquer `number` para `ttlMs`. O `RedisCacheAdapter` defende com `Math.max(1, ttlMs)` (linha 29), mas o `InMemoryCacheAdapter` (linha 30) faz `Date.now() + ttlMs` sem clamp — um `ttlMs` negativo gera entrada já expirada. O contrato não declara a faixa válida nem a unidade além do nome.
- **Impacto:** Divergência sutil entre adapters; baixa probabilidade dado que o consumidor calcula `ttl()` positivo. Ainda assim, o port não fixa o invariante.
- **Correção sugerida:** Documentar "`ttlMs` deve ser > 0" no JSDoc e, idealmente, padronizar o clamp nos adapters.

### L3 — Símbolo do token sem `Symbol.for` e sem reexport de tipo agrupado
- **Local:** linha 1
- **Descrição:** `Symbol('CACHE_PORT')` cria um símbolo único por carga de módulo. Em ambientes com duplicação de módulo (monorepos, múltiplos bundles, alguns cenários de teste/HMR), dois `CACHE_PORT` distintos podem coexistir e a injeção do Nest falha silenciosamente. `Symbol.for('CACHE_PORT')` usaria o registro global e seria robusto a isso.
- **Impacto:** Muito baixo no contexto atual (build único), mas é uma armadilha conhecida de DI com tokens-símbolo.
- **Correção sugerida:** Avaliar `Symbol.for('CACHE_PORT')` para idempotência entre instâncias de módulo, ou manter `Symbol()` conscientemente (é a escolha mais comum e evita colisão global de nomes).

---

## Pontos positivos
- Port bem nomeado e coeso, com JSDoc que comunica a intenção arquitetural (cache-aside, single-flight anti-stampede, stale-while-error) — raro e valioso num contrato.
- Aderência exemplar à arquitetura hexagonal: o port vive em `application/ports`, é genérico, **não** vaza nada de Redis/ioredis para o domínio; a dependência de infra está corretamente só nos adapters.
- Tipo de retorno rico (`{ value, hit, stale }`) que expõe observabilidade ao consumidor sem acoplar a port a uma lib de métricas.
- Uso correto de token `Symbol` para DI (evita colisão de strings) e injeção via `@Inject(CACHE_PORT)` no use-case.
- `getOrLoad` genérico em `T` preserva tipagem ponta a ponta sem `any`.

## Veredito
**Aprovado com ressalvas.** O contrato é sólido em arquitetura e legibilidade e não tem bug executável (não há código). As ressalvas são de **subespecificação**: a sentinela `undefined` para miss (H1) e o silêncio sobre o caminho de falha sem stale (H2) são lacunas reais que já produzem comportamento divergente/indesejado nos adapters e métricas. Recomenda-se enriquecer o JSDoc do contrato (semântica de `undefined`, falha/rethrow, `hit` coalescido, serializabilidade, relação `del`↔stale) antes de tratar este port como estável para novos adapters.
