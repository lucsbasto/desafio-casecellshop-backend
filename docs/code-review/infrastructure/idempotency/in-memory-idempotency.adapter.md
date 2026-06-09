# Code Review — src/infrastructure/idempotency/in-memory-idempotency.adapter.ts

## Resumo

Adapter in-memory simples e correto no caminho feliz: a seção crítica (`get` → comparação → `set`) é de fato síncrona, sem `await` intermediário, logo atômica no event loop do Node — o comentário do cabeçalho procede. O ponto fraco real não é concorrência, e sim **ciclo de vida das entradas**: chaves expiradas nunca são removidas (vazamento de memória não-limitado com TTL de 24h) e a ausência de validação/normalização de `ttlMs` (presente no adapter Redis via `Math.max(1, ttlMs)`) abre divergência de comportamento entre drivers, inclusive quebra silenciosa de idempotência com `NaN`.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 1          |
| LOW        | 3          |

---

## HIGH

### H1 — Vazamento de memória: entradas expiradas nunca são evictadas
**Local:** linhas 13, 18, 21 (estrutura `store` e ramo de escrita).

**Descrição:** O `Map` só é atualizado quando a *mesma* chave reaparece (linha 21 sobrescreve a entrada vencida). Para qualquer chave que nunca mais seja usada após expirar, a entrada permanece no `Map` para sempre. Não há `TTL` ativo, nem timer de limpeza, nem varredura preguiçosa que apague entradas vencidas. Com `IDEMPOTENCY_TTL_MS` documentado em 24h e chaves de alta cardinalidade (uma por requisição de checkout / `Idempotency-Key` por cliente), o `store` cresce monotonicamente.

**Impacto:** Em produção, mesmo que o driver padrão seja Redis, este adapter é o fallback default no `InfrastructureModule` (`infrastructure.module.ts:58`) e o usado nos testes. Sob carga sustentada vira vazamento de memória que leva a OOM do processo. Diferente do Redis (`SET ... PX`), que expira fisicamente a chave, aqui o `expiresAt` é apenas lógico — usado para *leitura*, nunca para *remoção*.

**Correção sugerida:** Eviction preguiçosa no `remember` (apaga a entrada vencida ao encontrá-la) combinada com uma varredura periódica de baixo custo. Mínimo viável:

```ts
async remember(key: string, orderId: string, ttlMs: number): Promise<IdempotencyRecord> {
  const now = Date.now();
  const existing = this.store.get(key);
  if (existing) {
    if (existing.expiresAt > now) {
      return { orderId: existing.orderId, created: false };
    }
    this.store.delete(key); // eviction preguiçosa do que já venceu
  }
  this.store.set(key, { orderId, expiresAt: now + Math.max(1, ttlMs) });
  return { orderId, created: true };
}
```

Como a eviction preguiçosa só cobre chaves revisitadas, adicione também uma limpeza periódica (ex.: `setInterval` registrado em `onModuleInit` / `onModuleDestroy` para respeitar o lifecycle NestJS e não vazar o timer, **com `.unref()`** para não segurar o processo). Para um adapter "de teste/desenvolvimento" isso pode ser deixado como TODO explícito; para uso real é obrigatório.

---

## MEDIUM

### M1 — `ttlMs` não é validado/normalizado; `NaN`/valores não-positivos divergem do Redis e podem quebrar idempotência
**Local:** linhas 15, 18, 21.

**Descrição:** O adapter Redis protege o TTL com `String(Math.max(1, ttlMs))` (`redis-idempotency.adapter.ts:32`). Aqui `ttlMs` entra cru em `now + ttlMs` (linha 21). Consequências por valor:
- `ttlMs <= 0`: `expiresAt <= now`, a entrada nasce já expirada → todo retry é tratado como `created: true` → idempotência **desligada** (cada requisição cria pedido novo).
- `ttlMs = NaN`: `expiresAt = NaN`; na leitura subsequente `existing.expiresAt > now` é `NaN > now` ⇒ `false` ⇒ a entrada é sempre considerada expirada ⇒ idempotência **silenciosamente quebrada**, sem erro.
- `ttlMs = Infinity`: entrada efetivamente eterna, agravando H1.

**Impacto:** Comportamento dependente do driver para a mesma configuração — um bug de config (`IDEMPOTENCY_TTL_MS` ausente/inválido → `NaN`) seria mascarado no Redis e catastrófico aqui, e o pior: falha de idempotência é silenciosa (sem exceção, sem log), violando o contrato central do port (1 pedido por `Idempotency-Key`).

**Correção sugerida:** Espelhar a normalização do Redis e rejeitar entradas claramente inválidas:

```ts
const safeTtl = Number.isFinite(ttlMs) ? Math.max(1, ttlMs) : 1;
this.store.set(key, { orderId, expiresAt: now + safeTtl });
```

Idealmente validar `ttlMs` de forma centralizada na config para que os dois adapters herdem a garantia, deixando o `Math.max` como defesa em profundidade.

---

## LOW

### L1 — `key` e `orderId` não são validados
**Local:** linha 15.

**Descrição:** `key === ''` é aceita como chave válida do `Map`, assim como `orderId` vazio. Não há guarda contra strings vazias. Não é injeção (é um `Map`, não query), mas uma chave vazia colide entre requisições não relacionadas que porventura cheguem sem `Idempotency-Key` resolvido a montante.

**Impacto:** Baixo — a montante (`checkout.usecase.ts`) já gera/resolve a chave; depende do invariante de que o caller nunca passa string vazia. Vale uma asserção defensiva.

**Correção sugerida:** `if (!key) throw new Error('idempotency key required');` no início, ou validar no boundary HTTP (já é o local mais idiomático).

### L2 — Divergência semântica documentada vs Redis na expiração concorrente
**Local:** linhas 18-22.

**Descrição:** O adapter Redis usa Lua `SET NX + GET` justamente para fechar o TOCTOU em que a chave expira entre escrita e leitura (`redis-idempotency.adapter.ts:6-16`). O in-memory, por ser síncrono, não tem esse problema — mas a equivalência alegada no comentário ("Equivalente a Redis SET NX EX") é aproximada: o Redis devolve sempre o `orderId` efetivamente armazenado (read-back), enquanto aqui, no ramo de criação, devolvemos o `orderId` recém-passado (linha 22). No fluxo single-process são equivalentes; a nuance é que este adapter **não** modela o cenário multi-instância (cada processo tem seu próprio `Map`), então em deploy com >1 réplica ele **não** garante idempotência. Isso é esperado para um adapter in-memory, mas merece um comentário explícito de "single-process only".

**Impacto:** Baixo e informacional, desde que o adapter nunca seja usado com múltiplas instâncias (o que o módulo deixa a cargo da config). Risco operacional se alguém promover o driver `memory` para produção multi-réplica.

**Correção sugerida:** Reforçar no comentário do cabeçalho: "Single-process only — não use com múltiplas réplicas; para isso use RedisIdempotencyAdapter."

### L3 — Ausência de teste unitário dedicado para o adapter
**Local:** arquivo inteiro (não há `*.spec.ts` correspondente).

**Descrição:** O adapter só é exercitado indiretamente via `checkout-flow.spec.ts`. Faltam testes diretos para: replay dentro do TTL (`created:false` + mesmo `orderId`), recriação após expiração, e os edge cases de `ttlMs` (0, negativo, `NaN`) — exatamente os que sustentam M1.

**Impacto:** Baixo; regressões em M1/H1 passariam despercebidas.

**Correção sugerida:** Adicionar `in-memory-idempotency.adapter.spec.ts` com casos: primeira reserva cria; segunda dentro do TTL é replay; após avançar o relógio (`jest.useFakeTimers`/mock de `Date.now`) recria; `ttlMs` inválido não desliga a idempotência silenciosamente.

---

## Pontos positivos

- **Atomicidade correta e bem justificada:** a seção crítica é genuinamente síncrona (sem `await` entre `get` e `set`), então a alegação de atomicidade no comentário é verdadeira para single-process. Raro ver esse raciocínio explicitado corretamente.
- **Aderência hexagonal exemplar:** implementa `IdempotencyPort` sem vazar nenhuma dependência de infra para o domínio; zero acoplamento a framework; substituível pelo adapter Redis via DI factory (`infrastructure.module.ts:52-59`).
- **Tipagem limpa:** sem `any`, sem asserções de tipo inseguras; `Stored` é um tipo interno enxuto e expressivo.
- **Simplicidade:** o código faz exatamente uma coisa, é trivial de ler e de auditar.
- **Contrato de retorno correto:** `{ created }` distingue criação de replay conforme o port exige, e o caminho de replay a montante (`checkout.usecase.ts:89-96`) é compatível.

---

## Veredito

**Aprovado com ressalvas.**

O adapter é correto no fluxo principal e arquiteturalmente sólido. Para uso além de teste/desenvolvimento, **H1 (vazamento de memória)** deve ser corrigido e **M1 (normalização de `ttlMs`)** alinhado ao adapter Redis para eliminar a quebra silenciosa de idempotência com `NaN`/valores não-positivos. Os achados LOW são endurecimentos recomendados (validação de chave, comentário de "single-process only" e teste unitário dedicado). Nenhum bloqueador caso o driver de produção seja sempre o Redis e este adapter permaneça restrito a testes — o que deveria ser tornado explícito.
