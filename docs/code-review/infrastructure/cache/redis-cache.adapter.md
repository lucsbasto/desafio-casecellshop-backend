# Code Review — src/infrastructure/cache/redis-cache.adapter.ts

Adapter Redis (cache-aside) com single-flight in-process, fallback stale-while-error e
eviction de valor corrompido. A lógica de happy-path está correta e bem documentada, mas
há problemas relevantes de escala multi-instância (leak de memória no `lastKnown`,
fallback stale ineficaz entre instâncias), perda silenciosa de erro no `del` durante
eviction e atomicidade do single-flight não estendida ao Redis.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 2         |
| MEDIUM     | 3         |
| LOW        | 3         |

---

## HIGH

### H1 — `lastKnown` é um `Map` in-process ilimitado: memory leak e fallback inconsistente em multi-instância
- **Local:** linhas 11, 30, 64-65
- **Descrição:** `lastKnown` é um `Map` em memória do processo que cresce a cada `set()` e
  **nunca é purgado**. Diferente do `inflight` (que faz `delete` no `finally`), `lastKnown`
  só acumula. Em um adapter cujo propósito é cache *distribuído*, isso gera dois problemas:
  1. **Memory leak:** com chaves dinâmicas (`products:${id}`, vide
     `list-products.usecase.ts` linha 11), o `Map` cresce sem limite ao longo do uptime —
     uma entrada permanente por produto/ID já consultado, sem TTL nem LRU.
  2. **Fallback inconsistente entre instâncias:** o stale-while-error só funciona na
     instância que executou o `set()` daquela chave. Em deployment com N réplicas atrás de
     um load balancer, a maioria das instâncias não terá `lastKnown` populado para a chave,
     e o fallback que o `ListProductsUseCase` depende (`staleOnError: true`) simplesmente
     não dispara — a requisição vira erro (500) de forma não-determinística conforme a
     réplica atingida.
- **Impacto:** Crescimento de memória ilimitado em produção (risco de OOM em uptime longo)
  e degradação de resiliência justamente no cenário que o fallback existe para cobrir
  (ERP fora do ar). O comportamento diverge do contrato implícito do `InMemoryCacheAdapter`,
  que num único processo sempre tem o `lastKnown`.
- **Correção sugerida:** Persistir o "último valor bom" no próprio Redis com uma chave/TTL
  separada (ex.: `stale:<key>` com TTL longo), tornando o fallback distribuído e sujeito a
  expiração natural. Em memória, no mínimo limitar o tamanho (LRU com cap) e documentar o
  trade-off. Exemplo de abordagem distribuída:

  ```ts
  private staleKey(key: string) { return `cache:stale:${key}`; }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const payload = JSON.stringify(value);
    const pipeline = this.redis.multi();
    pipeline.set(key, payload, 'PX', Math.max(1, ttlMs));
    pipeline.set(this.staleKey(key), payload, 'PX', this.staleTtlMs); // TTL longo
    await pipeline.exec();
  }
  // no fallback: const raw = await this.redis.get(this.staleKey(key));
  ```

### H2 — Single-flight é apenas in-process; não coalesce stampede entre instâncias
- **Local:** linhas 10, 46-58
- **Descrição:** O comentário do header e o `cache.port.ts` (linhas 4-6, "must protect
  against cache stampede") sugerem proteção anti-stampede. A implementação coalesce apenas
  requisições **dentro do mesmo processo**. Com N réplicas, um TTL expirado dispara até N
  execuções simultâneas do `loader` (o `repo.findAll()` / `findById`, ou seja, o "ERP").
  O header reconhece isso ("for cross-instance coordination a short SET NX lock would be
  used"), mas o lock NX **não está implementado** — apenas referenciado.
- **Impacto:** Sob carga real distribuída, o ERP (origem cara/instável, com `failRate`
  configurável) recebe rajadas concorrentes a cada expiração de chave quente — exatamente
  o thundering herd que o design diz mitigar. Em produção isso pode amplificar falhas do
  ERP e custar latência/disponibilidade.
- **Correção sugerida:** Implementar o lock distribuído `SET key NX PX <lockTtl>` antes de
  chamar o loader; quem não adquire o lock faz um pequeno backoff e relê o cache (ou serve
  stale). Alternativamente, deixar explícito em doc/README que o single-flight é *best-effort
  por processo* e que a TTL jitter é a única mitigação cross-instância — para não criar
  falsa sensação de garantia. Hoje a documentação superestima a proteção entregue.

---

## MEDIUM

### M1 — `del()` dentro do `get()` (eviction de valor corrompido) pode lançar e mascarar o miss
- **Local:** linhas 18-25
- **Descrição:** No `catch` do `JSON.parse`, faz-se `await this.redis.del(key)` antes de
  retornar `undefined`. Se o Redis estiver indisponível/instável nesse instante, o `del`
  rejeita e a exceção **substitui** o comportamento pretendido (tratar como miss). O comentário
  diz explicitamente que a intenção é "treat as a miss... instead of letting a SyntaxError
  bubble up and surface as a 500" — mas um erro de I/O no `del` reintroduz justamente um 500,
  agora com causa diferente da diagnosticada.
- **Impacto:** Um valor corrompido + Redis intermitente vira erro propagado em vez de miss
  silencioso; perde-se a robustez que o bloco pretendia oferecer.
- **Correção sugerida:** Tornar a eviction best-effort, isolando seu erro:

  ```ts
  } catch {
    void this.redis.del(key).catch(() => undefined); // best-effort, não bloqueia o miss
    return undefined;
  }
  ```

### M2 — Falhas silenciosas / ausência de observabilidade em caminhos de erro
- **Local:** linhas 20-25 (parse corrompido) e 64-66 (fallback stale)
- **Descrição:** Tanto a eviction de chave corrompida quanto o acionamento do fallback stale
  são caminhos anômalos relevantes para operação, mas não há log/métrica algum no adapter.
  O projeto tem `MetricsService`/`TracingService` (usados no use-case), porém o adapter
  engole esses eventos. Detectar "estou servindo stale porque o ERP caiu" ou "estou
  encontrando valores corrompidos no Redis" exigiria visibilidade aqui.
- **Impacto:** Incidentes silenciosos: corrupção de dados no cache ou dependência caída
  podem passar despercebidos; troubleshooting fica cego. O `catch {}` vazio (linha 20)
  também descarta a `SyntaxError` original sem registro.
- **Correção sugerida:** Emitir um `Logger.warn` (no mínimo) e/ou incrementar uma métrica
  nos dois pontos. Como o adapter é instanciado via `useFactory` sem DI, pode-se injetar um
  logger/metrics opcional no construtor a partir do `CacheProvider`.

### M3 — Race entre escrita e expiração: `set()` pode sobrescrever um `del()` concorrente / valor mais novo
- **Local:** linhas 28-31, 49-58
- **Descrição:** No `getOrLoad`, o resultado do `loader` é gravado com `set()` incondicional.
  Se entre o início do loader e o `set` ocorrer um `del(key)` (invalidação explícita) ou um
  `set` mais recente por outra instância, este `set` "atrasado" reescreve um dado já
  invalidado/atualizado, ressuscitando valor potencialmente stale com TTL cheio. Não há
  versionamento nem checagem. (Não é crítico para o uso atual — catálogo read-mostly — mas é
  uma armadilha clássica de cache-aside.)
- **Impacto:** Janela de inconsistência onde o cache passa a servir um valor obsoleto por
  todo o TTL após uma invalidação. Probabilidade baixa no domínio atual, porém real.
- **Correção sugerida:** Documentar a limitação; se precisar de correção, usar uma estratégia
  de invalidação baseada em versão/geração de chave (key bumping) ou checar/condicionar a
  escrita. Para o escopo atual, ao menos registrar a premissa "read-mostly, invalidação rara".

---

## LOW

### L1 — `set()` não trata `ttlMs` não finito / negativo de forma robusta
- **Local:** linha 29
- **Descrição:** `Math.max(1, ttlMs)` protege contra zero/negativos, mas se `ttlMs` for
  `NaN` ou `Infinity`, `Math.max(1, NaN) === NaN` e `Math.max(1, Infinity) === Infinity`,
  ambos resultando em argumento `PX` inválido para o ioredis. O `ttl()` do use-case soma
  `Math.random()*jitter` a um valor de config; se a config vier malformada, propaga.
- **Impacto:** Erro de runtime do Redis em vez de um TTL sanitizado; baixo risco dado que a
  config é validada em outro ponto, mas a defesa aqui é incompleta.
- **Correção sugerida:** `const px = Number.isFinite(ttlMs) ? Math.max(1, Math.floor(ttlMs)) : 1;`
  e usar `px`. O `Math.floor` também evita TTL fracionário.

### L2 — Tipagem fraca: `Map<string, unknown>` e asserções `as T` sem validação
- **Local:** linhas 10-11, 19, 47, 61, 65
- **Descrição:** O valor desserializado de `JSON.parse` é forçado para `T` sem qualquer
  validação de shape; o mesmo para `lastKnown.get(key) as T` e `(await existing) as T`. Se um
  produtor gravar um shape diferente do esperado pelo consumidor (ex.: mudança de schema entre
  deploys), o erro só aparece downstream, longe da origem. É uma limitação inerente a cache
  genérico, mas vale registrar.
- **Impacto:** Bugs de tipo difíceis de rastrear em evolução de schema; sem detecção precoce.
- **Correção sugerida:** Opcional — aceitar um validador/parser (ex.: função `decode: (raw) => T`)
  por chamada para validar na borda, ou documentar que o caller é responsável por garantir o
  shape. No mínimo, comentar a premissa.

### L3 — Documentação do header promete coordenação cross-instance que o código não entrega
- **Local:** linhas 4-8
- **Descrição:** O JSDoc afirma que "for cross-instance coordination a short SET NX lock
  would be used (referenced in the README)" e "Keeps the last value for stale-while-error
  fallback" — sem deixar claro que o lock NÃO existe no código e que o `lastKnown` é por
  processo (vide H1/H2). Comentário que descreve intenção como se fosse implementação induz
  o leitor ao erro.
- **Impacto:** Manutenção futura pode assumir garantias inexistentes (anti-stampede
  distribuído, fallback global).
- **Correção sugerida:** Ajustar o texto para distinguir claramente o que está implementado
  (single-flight in-process, eviction de corrompido, fallback local) do que é
  futuro/aspiracional (lock NX distribuído, stale distribuído).

---

## Pontos positivos
- Tratamento de valor corrompido (linhas 18-25): converter `SyntaxError` em miss + eviction
  é uma decisão acertada de robustez, evitando 500 por dado estranho no Redis.
- Single-flight in-process bem feito: `inflight.delete` no `finally` (linha 55) garante
  limpeza mesmo em erro do loader — sem leak no `inflight`.
- `JSON.stringify`/`parse` com `'PX'` e `Math.max(1, ttlMs)` evita o erro comum de TTL zero.
- Paridade de semântica com `InMemoryCacheAdapter` (estrutura `getOrLoad` idêntica),
  facilitando troca de driver via `CacheProvider`.
- Adapter limpo, sem vazamento de tipos de domínio (depende só da `CachePort` e do tipo
  `Redis` da infra) — boa aderência hexagonal na direção das dependências.
- Retorno estruturado `{ value, hit, stale }` permite ao consumidor (use-case) emitir métricas
  precisas de hit/miss/stale.

---

## Veredito
**Aprovado com ressalvas.** A lógica central está correta e idiomática, e o arquivo é seguro
para uso single-instance (como o demo). Para produção multi-instância, recomenda-se endereçar
**H1** (leak de memória do `lastKnown` + fallback distribuído) e **M1** (eviction best-effort
no `get`) antes do merge, e alinhar a documentação (H2/L3) para não prometer coordenação
distribuída que o código ainda não implementa. As demais ressalvas (M2/M3, LOW) são melhorias
incrementais.
