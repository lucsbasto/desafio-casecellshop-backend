# Code Review — src/domain/stock.ts

## Resumo

Módulo de domínio puro com duas funções (`tryReserve`, `release`) que expressam a REGRA de reserva de estoque, deixando a atomicidade para os adapters (Redis Lua / in-memory). O código é pequeno, sem dependências de infra (aderente ao hexagonal) e a regra está correta para o "caminho feliz". As fragilidades são todas de robustez de entrada: o tipo `number` admite `NaN`/`Infinity`/frações que escapam silenciosamente das guardas, há comportamentos silenciosos (clamp em `release`) e falta teste unitário dedicado para a camada de domínio.

| Severidade | Quantidade |
|-----------|-----------|
| CRITICAL  | 0 |
| HIGH      | 1 |
| MEDIUM    | 3 |
| LOW       | 3 |

---

## HIGH

### H1 — `NaN`/`Infinity`/frações passam pelas guardas e corrompem o saldo (linhas 13-17)

**Local:** `tryReserve`, linhas 14-16.

**Descrição:** As guardas usam apenas comparações relacionais (`quantity <= 0`, `current < quantity`). Comparações com `NaN` retornam sempre `false`, então:

- `tryReserve(NaN, 1)` → `1 <= 0` é `false`; `NaN < 1` é `false` → retorna `{ ok: true, remaining: NaN }`. Uma reserva é "aprovada" e o saldo vira `NaN`, que daí em diante contamina todo cálculo (`NaN < x` sempre falso ⇒ reservas seguintes podem ser indevidamente aprovadas, ou todas falham, dependendo do ramo).
- `tryReserve(5, NaN)` → `NaN <= 0` é `false`; `5 < NaN` é `false` → `{ ok: true, remaining: NaN }`. Reserva de quantidade inválida aprovada.
- `tryReserve(5, Infinity)` → `Infinity <= 0` falso; `5 < Infinity` verdadeiro → `{ ok: false }` (ok aqui), mas `tryReserve(Infinity, 1)` → `{ ok: true, remaining: Infinity }`.
- `tryReserve(5, 2.5)` → aprova reserva fracionária de unidades de estoque (`remaining: 2.5`).

**Impacto:** Numa função cujo propósito declarado (linhas 1-7) é ser a fonte da REGRA anti-oversell, uma entrada não-finita ou fracionária produz oversell silencioso ou trava o estoque. Hoje a exposição é mitigada porque os chamadores normalizam (`?? 0` no in-memory; `tonumber(... or '0')` no Lua) e o `quantity` vem de DTOs validados — mas a função de domínio não deveria depender dessa garantia externa para não violar a própria invariante. É o tipo de bug que só aparece sob dado corrompido/seed manual e é caríssimo de diagnosticar.

**Correção sugerida:** Validar que ambos são inteiros finitos não-negativos (e `quantity` positivo) antes de aplicar a regra. Falhar fechado (`ok: false`) em entrada inválida em vez de propagar `NaN`:

```ts
export function tryReserve(current: number, quantity: number): ReservationResult {
  if (!Number.isInteger(current) || current < 0) return { ok: false, remaining: current };
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, remaining: current };
  if (current < quantity) return { ok: false, remaining: current };
  return { ok: true, remaining: current - quantity };
}
```

`Number.isInteger` já rejeita `NaN`, `Infinity` e frações de uma vez. Se o domínio precisar suportar quantidades fracionárias (não é o caso de estoque de unidades), troque por `Number.isFinite` + checagem de sinal.

---

## MEDIUM

### M1 — `release` silenciosamente engole quantidades negativas (linhas 19-21)

**Local:** `release`, linha 20 (`Math.max(0, quantity)`).

**Descrição:** `release(10, -5)` retorna `10` sem erro nem sinal. O clamp converte uma chamada claramente inválida (compensação com quantidade negativa) num no-op silencioso.

**Impacto:** `release` é usado como **compensação** (rollback de reserva) em `checkout.usecase.ts:122`, `checkout.worker.ts:117` e `reconcile.usecase.ts:52`. Se um bug a montante passar um delta negativo, o estoque deveria ser reposto e não é — o produto fica "vazado" (oversell efetivo) e nenhum log/erro indica a causa. Falha silenciosa num caminho de compensação é especialmente perigosa porque compensação já é o "plano B".

**Correção sugerida:** Em domínio puro, sinalizar a violação em vez de mascarar. Ou lançar `DomainError`/retornar `Result`, ou no mínimo tratar negativo como erro de programação:

```ts
export function release(current: number, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError(`release: quantity inválida (${quantity})`);
  }
  return current + quantity;
}
```

Se a decisão de produto for "ser tolerante", então documente explicitamente o clamp e cubra com teste — mas tolerância silenciosa não combina com um invariante financeiro/estoque.

### M2 — `release` não valida `current` nem propaga a mesma regra do `tryReserve` (linhas 19-21)

**Local:** `release`, linha 20.

**Descrição:** `release(NaN, 5)` → `NaN`. `release(Infinity, 5)` → `Infinity`. Diferente de `tryReserve`, aqui não há nenhuma checagem do estado atual. As duas funções do mesmo módulo têm contratos de robustez divergentes para o mesmo tipo de entrada.

**Impacto:** Inconsistência de invariante dentro do próprio agregado de estoque: um saldo corrompido (`NaN`) entra e sai de `release` sem ser detectado, e como `tryReserve` (após H1) também não confiaria nesse valor, o módulo fica com dois entendimentos diferentes de "saldo válido". Dificulta raciocinar sobre a corretude do par reserve/release como unidade.

**Correção sugerida:** Aplicar a mesma guarda de inteiro não-negativo a `current` em ambas as funções (idealmente extraindo um helper `assertStock(n)`), garantindo um contrato único de "o que é um saldo válido".

### M3 — Ausência de teste unitário para a camada de domínio (`stock.ts`)

**Local:** módulo inteiro — não existe `stock.spec.ts` (há `order.spec.ts` para o domínio de pedido e `stock-concurrency.spec.ts` apenas para o adapter).

**Descrição:** A regra anti-oversell — provavelmente a invariante mais crítica do checkout — não tem teste unitário direto na camada onde ela é definida. O `stock-concurrency.spec.ts` exercita o adapter (concorrência), mas não cobre os edge cases puros de `tryReserve`/`release` (limite exato `current === quantity`, `quantity === 0`, negativos, e os casos `NaN`/`Infinity`/fração de H1).

**Impacto:** Regressões na regra de domínio passariam despercebidas; e justamente os edge cases de H1/M1/M2 são os que um teste de domínio rápido pegaria. Função pura é o caso ideal de teste barato e de alto valor.

**Correção sugerida:** Adicionar `src/domain/stock.spec.ts` cobrindo no mínimo: limite exato (`tryReserve(5,5) → ok, remaining 0`), insuficiência (`tryReserve(4,5) → !ok, remaining 4`), `quantity<=0`, e os casos de entrada inválida (`NaN`, `Infinity`, fração, negativos) tanto para `tryReserve` quanto para `release`.

---

## LOW

### L1 — Tipos primitivos `number` sem nominal typing para quantidade/saldo (linhas 8-21)

**Descrição:** `current`, `quantity` e `remaining` são todos `number` cru. Não há nada no tipo que impeça trocar a ordem dos argumentos de `tryReserve(current, quantity)` nas chamadas, nem que documente a unidade (unidades de estoque, inteiros não-negativos).

**Impacto:** Manutenibilidade/segurança de refactor. Um `tryReserve(quantity, current)` invertido compila silenciosamente.

**Correção sugerida (opcional):** Branded types (`type StockQty = number & { readonly __brand: 'StockQty' }`) ou ao menos JSDoc nos parâmetros declarando "inteiro >= 0". Baixo retorno para um módulo tão pequeno; registrar como melhoria.

### L2 — Duplicação da regra entre domínio e Lua/adapter sem ponto único de verdade (linhas 13-21 vs adapters)

**Descrição:** A regra `if qty <= 0 / if current < qty / decrement` existe três vezes: em `tryReserve` (TS), no `RESERVE_LUA` (`redis-stock.adapter.ts:13-20`) e implicitamente no in-memory. O `release` aparece em `stock.ts:20` e replicado no Redis (`incrby` com `Math.max(0, quantity)`, linha 44).

**Impacto:** Divergência futura: se a regra mudar (ex.: passar a rejeitar fração em H1), o Lua precisa ser atualizado em paralelo e nada força isso. O in-memory reusa `tryReserve` (bom); o Redis, por natureza, não pode reusar TS — mas convém um teste de paridade que rode os mesmos casos contra ambos os adapters.

**Correção sugerida:** Comentar no `stock.ts` que o `RESERVE_LUA` deve espelhar esta regra e adicionar um teste de contrato (table-driven) que valide ambos os adapters contra os mesmos casos de borda.

### L3 — Comentário de cabeçalho pode induzir falsa sensação de segurança (linhas 1-7)

**Descrição:** O cabeçalho afirma que a função "only expresses the RULE: reserve only if there is sufficient balance". Está correto em intenção, mas omite que a função NÃO valida domínio da entrada (não-finitos/frações), o que é exatamente o gap de H1.

**Impacto:** Documentação que descreve a garantia mais forte do que a entregue tende a desencorajar a adição das guardas.

**Correção sugerida:** Após implementar H1/M1, ajustar o comentário para refletir o contrato real (ex.: "rejeita entradas não-inteiras/negativas; aprova somente com saldo suficiente").

---

## Pontos positivos

- **Aderência hexagonal exemplar:** módulo de domínio 100% puro, sem nenhum import de infra; a atomicidade é corretamente delegada às ports/adapters, como o cabeçalho documenta (linhas 1-7).
- **Funções puras e determinísticas:** sem efeitos colaterais, fáceis de testar e de raciocinar; o in-memory reusa `tryReserve`/`release` evitando divergência nesse adapter.
- **Regra anti-oversell correta no caminho feliz:** o limite exato (`current === quantity`) é tratado certo (`current < quantity` ⇒ aprova quando igual), sem off-by-one.
- **Consistência do clamp com o Redis:** o `Math.max(0, quantity)` do `release` casa com o `Math.max(0, quantity)` do `incrby` no adapter Redis, mantendo o comportamento alinhado entre back-ends (embora o clamp em si seja questionável — ver M1).
- **`ReservationResult` explícito:** retornar `{ ok, remaining }` em vez de lançar exceção para o caso de negócio "saldo insuficiente" é idiomático e separa erro de negócio de erro excepcional.

---

## Veredito

**Aprovado com ressalvas.**

A arquitetura e a regra de negócio no caminho principal estão corretas e bem isoladas. As ressalvas concentram-se em robustez de entrada na camada de domínio: H1 (entradas não-finitas/fracionárias furando as guardas e gerando `NaN`/oversell) deve ser corrigida antes de considerar o módulo "blindado", e M1/M2 (falha silenciosa e contrato divergente em `release`) junto com M3 (teste unitário de domínio inexistente) são recomendados para fechar a invariante mais crítica do checkout. Nenhum achado é bloqueante dado que os chamadores atuais normalizam as entradas, mas um módulo de domínio que define a regra anti-oversell não deveria depender disso.
