# Code Review — src/infrastructure/stock/in-memory-stock.adapter.ts

## Resumo

Adapter in-memory que implementa `StockPort` delegando a regra de negócio para o domínio puro (`tryReserve`/`release`). O código é enxuto, correto para o caso single-thread do Node, mantém boa aderência hexagonal e o teste de concorrência cobre o cenário central (anti-overselling). Os achados são de severidade baixa, em sua maioria ligados a robustez de entrada e paridade com o adapter Redis.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 1          |
| LOW        | 4          |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

### M1 — Ausência de validação/normalização de entrada permite estado corrompido (`init`, `release`)

- **Local:** linhas 13-15 (`init`) e 31-34 (`release`).
- **Descrição:** `init` aceita qualquer `number` sem validação — `NaN`, valores negativos, fracionários ou `Infinity` são gravados diretamente no `Map`. Se `init('P', NaN)` for chamado, todo `reserve` subsequente falha silenciosamente porque `tryReserve(NaN, q)` cai em `current < quantity` (toda comparação com `NaN` é `false`, exceto `<` que retorna `false`, levando ao ramo de falha) e o saldo nunca se recupera. Em `release`, embora o domínio proteja contra negativo via `Math.max(0, quantity)`, um `NaN` em quantity propaga (`current + Math.max(0, NaN)` = `NaN`), corrompendo o saldo permanentemente.
- **Impacto:** Um seed inválido ou uma compensação com valor inválido envenena o saldo do produto de forma persistente e silenciosa — exatamente o tipo de falha difícil de diagnosticar em produção de checkout. O adapter Redis tem o mesmo problema latente (`String(NaN)` → `'NaN'`), então não é divergência, mas ambos merecem hardening na borda.
- **Correção sugerida:** Validar e normalizar na entrada do adapter (ou idealmente num value object de domínio). Exemplo mínimo:

```ts
private assertValidQuantity(quantity: number, op: string): void {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`${op}: quantity must be a non-negative integer, got ${quantity}`);
  }
}

async init(productId: string, quantity: number): Promise<void> {
  this.assertValidQuantity(quantity, 'init');
  this.stock.set(productId, quantity);
}
```

Observação: a regra de negócio de `reserve` (rejeitar `quantity <= 0`) já está corretamente no domínio; aqui trata-se apenas de impedir que entradas inválidas corrompam o *estado* do store.

---

## LOW

### L1 — `productId` não é validado (string vazia / `undefined` em runtime)

- **Local:** linhas 13, 17, 21, 31 (todos os métodos).
- **Descrição:** `productId` é tipado como `string`, mas em runtime (entrada vinda de HTTP/fila) pode chegar `''`, com espaços, ou `undefined` driblando o tipo. Uma string vazia cria uma chave válida no `Map`, mascarando bugs de upstream. Não há injeção possível num `Map` JS (chave é tratada como valor opaco), então não é risco de segurança — é higiene de borda.
- **Impacto:** Baixo; bugs silenciosos de chave vazia. A validação de borda já deveria ocorrer no DTO/controller, mas defesa em profundidade no adapter de estado é barata.
- **Correção sugerida:** Opcional — `if (!productId) throw new TypeError('productId is required')` nos métodos de escrita, ou confiar na validação do DTO de entrada (documentar a premissa).

### L2 — Divergência semântica com o adapter Redis em `get` de produto inexistente

- **Local:** linhas 17-19.
- **Descrição:** `get` retorna `0` para produto não inicializado (`?? 0`), idêntico ao `RedisStockAdapter.get` (`v === null ? 0`). A paridade aqui está **correta**. O ponto de atenção é que tanto memory quanto Redis tratam "produto inexistente" e "produto com saldo 0" como indistinguíveis. Para a lógica de checkout isso é aceitável (não há reserva possível em nenhum dos casos), mas impede diferenciar "SKU desconhecido" de "esgotado" sem outra consulta.
- **Impacto:** Muito baixo; é uma decisão de design consistente entre os dois adapters. Citado apenas para consciência.
- **Correção sugerida:** Nenhuma mudança necessária. Se a distinção for relevante no futuro, expor um `has(productId)` na port.

### L3 — Mapeamento manual `{ ok, remaining }` poderia reusar o tipo de domínio

- **Local:** linha 28 — `return { ok: result.ok, remaining: result.remaining };`.
- **Descrição:** `ReservationResult` (domínio) e `ReserveOutcome` (port) têm estrutura idêntica (`{ ok: boolean; remaining: number }`). O re-mapeamento campo a campo é redundante; `return result;` seria estruturalmente compatível. O re-mapeamento explícito é defensável como "anti-corruption" entre camadas, mas como hoje os tipos são gêmeos isso é cerimônia sem ganho.
- **Impacto:** Cosmético. Não há bug.
- **Correção sugerida:** Simplificar para `return { ok: result.ok, remaining: result.remaining };` → `return result;` (mantém compatibilidade estrutural), OU manter como está deliberadamente se a intenção for isolar evolução futura dos dois tipos. Decisão de estilo.

### L4 — Falta de `OnApplicationShutdown`/limpeza e crescimento ilimitado do `Map`

- **Local:** linha 11 — `private readonly stock = new Map<string, number>();`.
- **Descrição:** O `Map` cresce monotonicamente: nunca há `delete`. Em um adapter in-memory usado para testes/dev isso é irrelevante, mas se este provider for usado como fallback de produção (singleton NestJS), produtos seedados acumulam sem expurgo. Não há leak por reserva (chave reusada), apenas por número de SKUs distintos — limitado na prática.
- **Impacto:** Baixíssimo no contexto declarado (in-memory = dev/teste/equivalência didática do DECRBY). Citado para completude.
- **Correção sugerida:** Nenhuma para o escopo atual. Se virar caminho de produção, considerar expor `clear`/`delete` na port ou documentar explicitamente que o adapter é não-persistente e somente para dev/teste.

---

## Pontos positivos

- **Atomicidade correta e bem justificada:** o comentário das linhas 4-9 e 22 documenta com precisão por que a seção crítica é atômica no Node single-thread (sem `await` entre leitura e escrita), e o teste `stock-concurrency.spec.ts` prova empiricamente o anti-overselling (50 reservas concorrentes → exatamente 10 sucessos, saldo 0). Excelente.
- **Aderência hexagonal exemplar:** zero vazamento de infra no domínio; toda a regra (`tryReserve`, `release`) vive no domínio puro e o adapter apenas orquestra leitura/escrita do store. A port (`StockPort`) é a única dependência da aplicação.
- **Paridade conceitual com Redis:** o adapter espelha fielmente a semântica do `RESERVE_LUA` (check-and-decrement condicional), tornando os dois intercambiáveis sem surpresa comportamental.
- **Sem `any`, sem asserções de tipo inseguras, sem catch vazio.** Tipos limpos e métodos pequenos e legíveis.
- **`?? 0` consistente** em `get`, `reserve` e `release` para o caso de chave ausente — tratamento de `undefined` coerente.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é sólido, correto e bem documentado para seu propósito. A única ressalva acionável é **M1** (validação/normalização de quantidade na borda para impedir corrupção silenciosa do saldo por `NaN`/negativos/fracionários), idealmente aplicada de forma simétrica também ao `RedisStockAdapter`. Os demais achados são higiene opcional e decisões de estilo, sem bloqueio de merge.
