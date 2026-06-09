# Code Review — src/infrastructure/stock/redis-stock.adapter.ts

## Resumo

O adapter resolve corretamente o problema central de overselling usando um script Lua atômico (`GET` + verificação + `DECRBY` em uma única operação no servidor Redis), eliminando o TOCTOU mesmo entre múltiplas instâncias da aplicação. O desenho é sólido e idiomático. As ressalvas concentram-se em validação de entrada inconsistente com o domínio (frações causam exceção do Redis), tratamento silencioso de valores corrompidos (`NaN`), e ausência de hardening de erros. Nenhum problema crítico de correção concorrente foi encontrado.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 2          |
| MEDIUM     | 3          |
| LOW        | 4          |

---

## HIGH

### H1 — Quantidade fracionária derruba `reserve`/`release` com erro bruto do Redis
**Local:** linhas 33-41 (`reserve`), 43-45 (`release`); Lua linhas 13-20.

**Descrição:** O contrato `StockPort` tipa `quantity: number` (não inteiro). O `InMemoryStockAdapter` aceita frações sem problema (usa subtração JS pura). Já o caminho Redis envia `String(quantity)` para o Lua, que faz `DECRBY`/`INCRBY`. `DECRBY`/`INCRBY` do Redis **só aceitam inteiros**: um valor como `1.5` faz o comando lançar `ERR value is not an integer or out of range`, que escapa como exceção não tratada. Note que no Lua o `tonumber('1.5')` passa pela checagem `qty <= 0` e `current < qty` sem erro, e a falha só ocorre no `DECRBY` — ou seja, a verificação de saldo pode "passar" e ainda assim explodir.

**Impacto:** Comportamento divergente entre os dois drivers do mesmo port (quebra a substitutibilidade Liskov dos adapters hexagonais) e exceção de infraestrutura propagada crua para a camada de aplicação. Em produção (driver=redis) uma quantidade fracionária causa erro 500 em vez de uma falha de reserva controlada.

**Correção sugerida:** Validar/normalizar para inteiro não-negativo na fronteira do adapter, falhando explicitamente e de forma consistente com o in-memory:

```ts
private static assertPositiveInt(quantity: number, op: string): void {
  if (!Number.isInteger(quantity)) {
    throw new TypeError(`${op}: quantity deve ser inteiro, recebido ${quantity}`);
  }
}
```

Ou, melhor ainda, fortalecer o Lua para retornar `{0, current}` quando `qty` não for inteiro (`if qty ~= math.floor(qty) then return {0, current} end`), mantendo o caminho de "reserva recusada" coerente em vez de lançar exceção.

### H2 — `release` sem limite superior permite "over-release" (saldo inflado silenciosamente)
**Local:** linha 44.

**Descrição:** `release` faz `INCRBY` com `Math.max(0, quantity)` sem qualquer teto. Se a compensação for chamada com quantidade maior do que foi reservada — por bug de orquestração, retry de compensação não-idempotente, ou mensagem duplicada na fila — o saldo cresce acima do estoque real. Como o sistema usa filas (BullMQ) com retries, uma compensação reentrante é um cenário realista, e nada aqui torna o `release` idempotente.

**Impacto:** Overselling pela porta dos fundos: o estoque pode ser inflado acima do físico, permitindo reservas que não deveriam existir. Em e-commerce isso é exatamente o defeito que a reserva atômica tenta evitar.

**Correção sugerida:** A idempotência da compensação idealmente é responsabilidade do orquestrador/saga (token de reserva), mas o adapter pode oferecer um teto opcional ou, no mínimo, documentar a pré-condição. Se houver um valor inicial conhecido (`init`), considere um script Lua que faça `INCRBY` limitado a um máximo. No mínimo, deixar explícito no contrato do port que `release` deve ser chamado no máximo uma vez por reserva bem-sucedida.

---

## MEDIUM

### M1 — `get` retorna `NaN` silenciosamente para valores corrompidos
**Local:** linhas 28-31.

**Descrição:** `Number(v)` converte qualquer string não-numérica em `NaN` (ex.: chave sobrescrita por outro processo, corrupção, ou um valor não-numérico setado fora do adapter). O `NaN` é retornado como se fosse um saldo válido e contamina toda aritmética a jusante (`NaN < qty` é `false` em comparações, mas no Lua a leitura usa `tonumber(...) or '0'`, então os caminhos divergem).

**Impacto:** Falha silenciosa difícil de diagnosticar; um `NaN` propagado pode mascarar estado inválido e produzir decisões de reserva incorretas.

**Correção sugerida:**
```ts
async get(productId: string): Promise<number> {
  const v = await this.redis.get(KEY(productId));
  if (v === null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Saldo corrompido para ${productId}: "${v}"`);
  }
  return n;
}
```

### M2 — `init` não valida a entrada e permite semear estoque inválido/negativo
**Local:** linhas 24-26.

**Descrição:** `init` faz `set(KEY, String(quantity))` sem validar. `quantity` negativo, fracionário ou `NaN` é persistido como string. Um `NaN` vira a string `"NaN"`; no Lua `tonumber('NaN')` é `nil` em Redis e cai no `or '0'`, enquanto `get` retornaria `NaN` — comportamento divergente entre leitura JS e leitura Lua para o mesmo estado.

**Impacto:** Estoque seed corrompido entra no sistema sem detecção e diverge entre os dois caminhos de leitura.

**Correção sugerida:** Validar `Number.isInteger(quantity) && quantity >= 0` em `init` (e reusar a mesma normalização de H1).

### M3 — Asserção de tipo `as [number, number]` sem validação de runtime
**Local:** linhas 34-39.

**Descrição:** O retorno de `redis.eval` é tipado como `unknown` pelo ioredis e forçado via `as [number, number]`. Embora o Lua atual sempre retorne uma tupla de dois números, a asserção não tem guarda de runtime: uma mudança futura no script, um erro de Redis, ou um cliente com serialização diferente produziria um valor que não bate com o tipo, e o `Number(remaining)` mascararia parte do problema (`Number(undefined)` → `NaN`).

**Impacto:** Fragilidade de tipo; bugs de refatoração do Lua passam despercebidos pelo compilador.

**Correção sugerida:** Validar a forma do retorno antes de desestruturar:
```ts
const raw = await this.redis.eval(/* ... */);
if (!Array.isArray(raw) || raw.length < 2) {
  throw new Error('Resposta inesperada do script de reserva');
}
const [ok, remaining] = raw as [number, number];
```

---

## LOW

### L1 — Erros de infraestrutura propagam crus (sem wrapping)
**Local:** todos os métodos.

**Descrição:** Nenhum método encapsula falhas do cliente Redis (timeout, conexão perdida) em um erro de domínio/aplicação. A exceção bruta do ioredis vaza para a camada de aplicação, acoplando-a aos detalhes do driver — leve atrito com a arquitetura hexagonal.

**Correção sugerida:** Opcionalmente envolver em um erro de port (ex.: `StockUnavailableError`) para preservar a fronteira. Dado o escopo do desafio, é aceitável como está, mas vale registrar.

### L2 — Sem observabilidade no adapter
**Local:** classe inteira.

**Descrição:** O projeto enfatiza OpenTelemetry/Prometheus, mas o adapter não emite spans/métricas (latência do `eval`, taxa de reservas recusadas, saldo). A reserva é o ponto mais crítico do checkout e seria o primeiro lugar a instrumentar.

**Correção sugerida:** Adicionar um span por `reserve` e um contador de `ok`/recusas. Pode ficar em um decorator para não poluir o adapter.

### L3 — `Number(remaining)` redundante e potencialmente mascarador
**Local:** linha 40.

**Descrição:** `remaining` já é tipado como `number` pela asserção; o `Number(remaining)` extra é redundante e, pior, converteria `undefined` em `NaN` silenciosamente caso a asserção esteja errada (ver M3). Após validar o retorno (M3), o cast é desnecessário.

**Correção sugerida:** Remover o `Number(...)` após introduzir a guarda de runtime, ou mantê-lo apenas se a validação não for adicionada.

### L4 — Ausência de teste específico para o `RedisStockAdapter`
**Local:** N/A (lacuna de cobertura).

**Descrição:** O único teste de concorrência (`stock-concurrency.spec.ts`) exercita apenas o `InMemoryStockAdapter`. O caminho Lua — que é o que roda em produção e contém a lógica atômica não-trivial — não tem teste (nem com `ioredis-mock` nem com Redis em container). Edge cases como `qty <= 0`, saldo exato, e quantidade fracionária (H1) ficam sem rede de segurança.

**Correção sugerida:** Adicionar um spec com `ioredis-mock` (ou testcontainers) cobrindo: reserva bem-sucedida, recusa por saldo insuficiente, `qty <= 0`, saldo na fronteira (`current == qty`), e o comportamento esperado para quantidade fracionária.

---

## Pontos positivos

- **Atomicidade correta:** o script Lua roda `GET` + check + `DECRBY` atomicamente no servidor, eliminando TOCTOU entre instâncias — exatamente a solução certa para o problema de overselling. Comentário explica bem o porquê (linhas 6-10, 12).
- **Sem injeção:** `eval` usa `KEYS[1]`/`ARGV[1]` parametrizados; `productId` nunca é interpolado no corpo do script. Mesmo nas chaves construídas via template, valores arbitrários são seguros como chave Redis.
- **Lua guarda `qty <= 0`** (linha 16), retornando recusa em vez de mutar o estado — coerente com o domínio `tryReserve`.
- **Script como constante estática** (`RESERVE_LUA`), reaproveitado entre chamadas — evita realocação e mantém o cache de script do Redis eficiente.
- **Adapter enxuto e focado**, aderente ao port; DI via factory no módulo está correta (provider com escopo singleton, sem vazamento de infra no domínio).
- **`get` trata `null`** (chave inexistente) explicitamente em vez de retornar `NaN` para esse caso.

---

## Veredito

**Aprovado com ressalvas.**

O núcleo concorrente está correto e bem implementado — não há defeito de atomicidade ou overselling no caminho principal. As ressalvas HIGH (H1: frações causam exceção bruta e divergência entre drivers; H2: `release` sem teto pode inflar estoque sob retries de fila) devem ser endereçadas antes de produção, pois ambas reabrem, por caminhos laterais, o risco que o adapter foi projetado para fechar. As demais são hardening de robustez/observabilidade e cobertura de teste.
