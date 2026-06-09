# Code Review — src/application/use-cases/list-products.usecase.ts

## Resumo

Use case de storefront (read-only) que lê produtos via cache-aside (TTL + single-flight) sobre o "ERP fake", com fallback stale-on-error, métricas de hit/miss/stale e tracing. O arquivo é pequeno, coeso e adere bem à arquitetura hexagonal (depende só de portas e tipos de domínio). Os problemas reais estão em (a) colisão de chave de cache entre `getById('all')` e a lista, (b) cache penetration em `getById` para id inexistente, e (c) span vazado/ausente quando o loader falha ou em `getById`.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0          |
| HIGH       | 2          |
| MEDIUM     | 3          |
| LOW        | 3          |

---

## HIGH

### H1 — Colisão de chave de cache: `getById('all')` colide com `ALL_KEY`
- **Local:** linhas 10–11, 49 (`ALL_KEY = 'products:all'`, `ONE_KEY = id => 'products:${id}'`).
- **Descrição:** `ALL_KEY` é literalmente `'products:all'`. `ONE_KEY('all')` produz exatamente a mesma string. Um request `GET /products/all` faz `getOrLoad('products:all', ...)` com loader `findById('all')`, podendo (1) sobrescrever a entrada da listagem completa com o resultado de `findById('all')`, e (2) servir o array completo de produtos como se fosse um único produto, ou vice-versa, dependendo de qual loader popula a chave primeiro (single-flight compartilha a MESMA promise entre callers das duas operações).
- **Impacto:** corrupção de cache cross-endpoint e cross-tipo (`Product[]` vs `Product | undefined`). Em produção, um cliente pode receber dados errados; em pior caso, o `value.map(toProductView)` de `listAll` recebe um objeto não-array e quebra, ou `getById` recebe um array. É um bug de correção sério e potencialmente explorável (envenenamento de cache via id escolhido).
- **Correção sugerida:** usar namespaces de chave disjuntos e não-colidíveis, e validar/encodar o id.
  ```ts
  const ALL_KEY = 'products:list:all';
  const ONE_KEY = (id: string) => `products:item:${encodeURIComponent(id)}`;
  ```

### H2 — Cache penetration: id inexistente nunca é cacheado e bate no ERP a cada request
- **Local:** linhas 47–55 (`getById`) em conjunto com o adapter (`getOrLoad`/`get`, in-memory-cache.adapter.ts:44–45).
- **Descrição:** `findById` retorna `Product | undefined`. Quando o produto não existe, o loader resolve `undefined`. O adapter armazena via `set(key, undefined, ttl)`, mas `get<T>` retorna `undefined` tanto para "ausente" quanto para "valor undefined cacheado", e `getOrLoad` trata `cached !== undefined` como hit. Resultado: o valor `undefined` nunca conta como hit — **todo** request para um id inexistente atravessa o cache e executa o loader do ERP novamente.
- **Impacto:** vetor de negação de serviço / amplificação de latência: um atacante (ou crawler) batendo em ids aleatórios inexistentes martela o "ERP" síncrono a cada chamada, anulando o cache exatamente no caso de maior risco. Também distorce as métricas (sempre `miss`).
- **Correção sugerida:** ou (a) lançar `ProductNotFoundError` antes de cachear (mas então nada é cacheado), ou preferencialmente (b) cachear negativamente um sentinela e tratar no use case, com TTL curto:
  ```ts
  const NOT_FOUND = Symbol('not-found');
  const { value } = await this.cache.getOrLoad(ONE_KEY(id), this.ttl(),
    async () => (await this.repo.findById(id)) ?? NOT_FOUND, { staleOnError: true });
  if (value === NOT_FOUND || !value) throw new ProductNotFoundError(id);
  ```
  Idealmente com TTL negativo curto e dedicado para evitar reter "not found" por muito tempo. No mínimo, documentar a limitação. (Observação: a causa raiz está no contrato do `CachePort`/adapter que não distingue "ausente" de "undefined cacheado"; vale uma issue na porta.)

---

## MEDIUM

### M1 — Span `cache.get` vazado quando `getOrLoad` lança em `listAll`
- **Local:** linhas 35–42.
- **Descrição:** `startSpan('cache.get')` é criado na linha 35, mas `span.end(...)` só é chamado na linha 42. Se `getOrLoad` rejeitar (loader falha e `staleOnError` não encontra valor — ver adapter linha 75 `throw err`), a exceção propaga e `span.end` nunca executa. O span fica permanentemente sem fechamento no ring buffer (e nunca registra duração/erro).
- **Impacto:** perda de observabilidade justamente no caminho de falha — onde tracing é mais valioso. Spans sem `end` poluem diagnósticos.
- **Correção sugerida:** envolver com `withSpan` (que já trata erro, ver tracing.service.ts:52–66) ou try/finally:
  ```ts
  return this.tracing.withSpan('cache.get', async () => {
    const { value, hit, stale } = await this.cache.getOrLoad(/* ... */);
    this.metrics.cacheRequests.inc({ result: stale ? 'stale' : hit ? 'hit' : 'miss' });
    return value.map(toProductView);
  }, { key: ALL_KEY });
  ```
  Nesse caso o atributo `{ hit, stale }` pode ser anexado via `span.end` interno; ajustar conforme a API.

### M2 — `getById` sem nenhum span (observabilidade assimétrica)
- **Local:** linhas 47–57.
- **Descrição:** `listAll` instrumenta `cache.get` e o loader instrumenta `erp.fetch` (linha 39). Já `getById` não cria span algum, e o loader (linha 51) chama `this.repo.findById(id)` sem `withSpan('erp.fetch', ...)`. Os dois métodos têm comportamento de I/O equivalente, mas só um é observável.
- **Impacto:** buracos de tracing/latência no caminho por id; impossível correlacionar latência do ERP em `getById`. Inconsistência dificulta dashboards.
- **Correção sugerida:** espelhar a instrumentação de `listAll`: envolver `getById` com um span `cache.get` e o loader com `withSpan('erp.fetch', () => this.repo.findById(id))`.

### M3 — Métrica não registrada se `getOrLoad`/`map` lançar
- **Local:** linhas 43–44 e 54.
- **Descrição:** `this.metrics.cacheRequests.inc(...)` está depois do `await getOrLoad`. Se o loader falhar sem stale disponível, a request de cache não é contabilizada em nenhum bucket (nem `miss`). Não há um label de `error`. Assim a soma de `hit+miss+stale` subconta o total real de tentativas.
- **Impacto:** métricas enganosas; taxa de erro do ERP fica invisível nesse contador (depende de outro lugar capturá-la). Dificulta alertas de saturação/falha do ERP.
- **Correção sugerida:** capturar o erro e incrementar com um resultado `error` (ou um contador dedicado) antes de re-lançar; ou contar a "tentativa" antes do await e o "resultado" depois.

---

## LOW

### L1 — TTL recomputado por chamada com jitter; sem garantia de jitter mínimo
- **Local:** linhas 27–32.
- **Descrição:** `ttl()` é avaliado a cada chamada (ok), mas `Math.floor(Math.random() * stampedeJitterMs)` pode ser 0, e se `stampedeJitterMs` vier 0/NaN (config), o jitter degenera. `num()` já protege NaN com default, então é baixo. Apenas observe que jitter pode ser 0 — anti-stampede fica sem margem nesse tick.
- **Impacto:** mínimo; em pico improvável de expirações alinhadas o single-flight do adapter ainda protege.
- **Correção sugerida:** opcional — jitter centrado (`base + (random*2-1)*jitter`) ou garantir piso. Não bloqueante.

### L2 — `Math.random()` não-cripto para jitter
- **Local:** linha 30.
- **Descrição:** `Math.random()` é adequado para jitter de TTL (não-segurança). Apenas registrando que não deve ser confundido com fonte segura — aqui está correto o uso.
- **Impacto:** nenhum (uso legítimo). Mantido por completude da revisão.
- **Correção sugerida:** nenhuma ação necessária.

### L3 — Ausência de teste unitário para o use case
- **Local:** arquivo inteiro (não há `list-products.usecase.spec.ts`).
- **Descrição:** existe `cache.spec.ts` para o adapter, mas o use case não tem teste cobrindo: mapeamento `toProductView`, propagação de `ProductNotFoundError` em `value` undefined, labels de métrica (hit/miss/stale) e o caso de colisão/penetração (H1/H2).
- **Impacto:** regressões em mapeamento, métricas e fluxo de erro passam despercebidas.
- **Correção sugerida:** adicionar spec com `CachePort`/`ProductRepositoryPort` mockados cobrindo: hit, miss, stale, not-found (lança), e o id `'all'` (regressão de H1).

---

## Pontos positivos

- Aderência hexagonal exemplar: depende apenas de portas (`CachePort`, `ProductRepositoryPort`), config tipada e tipos de domínio; nenhuma infra (Redis, HTTP) vaza para o use case.
- `toProductView` isola o read model público do `Product` interno (não vaza detalhes), aplicado corretamente nas duas saídas.
- Uso correto do cache-aside com single-flight + stale-on-error delegado ao adapter; o use case não reimplementa concorrência.
- DI idiomático NestJS (`@Inject` com Symbols para as portas, services concretos por classe), métodos `async` limpos e bem nomeados.
- Jitter de TTL para mitigar stampede é uma boa prática deliberada e documentada.
- `getById` lança `ProductNotFoundError` (domínio) em vez de vazar HTTP, mantendo a tradução de erro na borda.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é bem estruturado e arquiteturalmente sólido, mas H1 (colisão de chave `products:all`) é um bug de correção real e potencialmente explorável que deve ser corrigido antes do merge, e H2 (cache penetration em id inexistente) é um vetor de carga sobre o ERP que merece tratamento. Os achados MEDIUM (spans vazados/ausentes e métrica não contabilizada em erro) degradam observabilidade no caminho de falha e devem ser endereçados em seguida. Nenhum achado é CRITICAL.
