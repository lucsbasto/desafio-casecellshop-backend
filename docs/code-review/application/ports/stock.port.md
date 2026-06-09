# Code Review — src/application/ports/stock.port.ts

## Resumo

Arquivo de porta (interface) pequeno, bem nomeado e coerente com a arquitetura hexagonal: define o contrato `StockPort` e o token de DI `STOCK_PORT` sem vazar infraestrutura. Os problemas são de **especificação de contrato**: a interface não fixa garantias (faixas de tipos, semântica de `quantity`, idempotência de `init`/`release`, comportamento de produto inexistente) que os adaptadores e consumidores hoje assumem de forma divergente e implícita. Nenhum bug de runtime no próprio arquivo, mas o contrato frouxo permite divergências silenciosas entre adaptadores.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 3         |
| LOW        | 4         |

---

## MEDIUM

### M1 — Contrato não especifica a semântica de `quantity` (inteiro positivo) nem quem valida

**Local:** linhas 15, 18, 20 (`init`, `reserve`, `release`).

**Descrição:** As três operações recebem `quantity: number`, mas o contrato não declara o domínio válido (inteiro? > 0? limite superior?). Os adaptadores tratam isso de forma **inconsistente**:
- `reserve` no domínio/adaptadores rejeita `quantity <= 0` retornando `{ ok: false }` (`src/domain/stock.ts:14`, Lua em `redis-stock.adapter.ts:16`).
- `release` faz `Math.max(0, quantity)`, ou seja, **engole silenciosamente** valores negativos (`in-memory-stock.adapter.ts:33`, `redis-stock.adapter.ts:44`).
- `init` não valida nada: `init(p, -5)` ou `init(p, 3.5)` é aceito e persiste um saldo inválido (`String(quantity)` no Redis; número cru no Map).

Além disso, valores não-inteiros (ex.: `2.5`) passam por `reserve` e o saldo Redis vira fracionário, embora o domínio seja unidades discretas de produto.

**Impacto:** Sem o contrato fixar "inteiro não-negativo" (e `reserve`/`release` exigirem `> 0`), cada adaptador define sua própria política. Um saldo negativo ou fracionário corrompe o invariante de estoque e o cálculo anti-oversell, sem erro visível. É uma falha silenciosa de validação na fronteira do domínio.

**Correção sugerida:** Documentar o invariante no JSDoc do contrato e, idealmente, expressar via tipo nominal (branded type) para forçar validação na borda:

```ts
/** Inteiro >= 0. Validação é responsabilidade do caller/adapter na fronteira. */
export type StockQuantity = number; // idealmente um branded type validado

export interface StockPort {
  /** quantity deve ser inteiro >= 0; define o saldo absoluto (idempotente). */
  init(productId: string, quantity: number): Promise<void>;
  /** quantity deve ser inteiro > 0; reserva apenas se saldo >= quantity. */
  reserve(productId: string, quantity: number): Promise<ReserveOutcome>;
  /** quantity deve ser inteiro > 0; devolve quantity ao saldo (compensação). */
  release(productId: string, quantity: number): Promise<void>;
}
```

---

### M2 — `get`/`reserve` para produto inexistente: contrato não define se é 0 ou erro

**Local:** linha 16 (`get`), linha 18 (`reserve`).

**Descrição:** Ambos os adaptadores tratam "chave ausente" como saldo `0` (`in-memory:18,23` com `?? 0`; `redis:30` com `v === null ? 0` e o Lua `GET ... or '0'`). Isso significa que `reserve` em produto **nunca inicializado** retorna `{ ok: false, remaining: 0 }` — indistinguível de "produto existe mas está esgotado". O contrato não documenta essa escolha.

No `checkout.usecase.ts:104-113`, a validação de existência do produto vem de `products.findById` (repositório), não do estoque; então um produto válido sem `init` de estoque resultará em `InsufficientStockError` em vez de um erro de configuração/seed. Isso é uma decisão arquitetural legítima, mas **precisa estar no contrato** para que futuros consumidores não confundam "esgotado" com "não inicializado".

**Impacto:** Ambiguidade semântica entre "saldo zero" e "produto desconhecido". Mascarar a falta de seed como "estoque insuficiente" dificulta diagnóstico operacional (oversell metric/alertas disparam por motivo errado).

**Correção sugerida:** Documentar explicitamente no JSDoc: "`get` retorna `0` para produto não inicializado; `reserve` trata produto desconhecido como saldo 0 (⇒ `ok:false`). A existência do produto é garantida pelo `ProductRepositoryPort`, não por esta porta." Se a distinção importar no futuro, considerar um retorno tri-estado ou um método `exists`.

---

### M3 — Falta semântica de erro/falha do contrato (o que acontece quando a infra falha?)

**Local:** todas as assinaturas (retornam `Promise<...>`).

**Descrição:** O contrato não declara o que um adaptador pode **lançar**. `RedisStockAdapter` propaga falhas de conexão/`eval` do ioredis como rejeições. No `checkout.usecase.ts:102-125`, uma rejeição de `reserve` cai no `catch` que executa compensação (`release`) dos itens já reservados — mas se a falha foi do próprio Redis (indisponível), o `release` de compensação também falhará, e a idempotência já consumiu a chave (`remember` em :88). O contrato silencioso sobre falhas impede que consumidores raciocinem sobre esse caminho.

Há também risco de **parsing silencioso** no Redis: `get` faz `Number(v)` (:30) sem validar `NaN`; um valor corrompido na chave vira `NaN` e propaga sem erro. Embora seja problema do adaptador, decorre do contrato não exigir "saldo numérico válido".

**Impacto:** Caminhos de falha de estoque não são parte do contrato; cada consumidor improvisa. Combinado com a idempotência já reivindicada, uma falha de `reserve` por indisponibilidade pode deixar a chave de idempotência "presa" sem pedido (vide `DuplicateRequestError` em :96), exigindo reconciliação.

**Correção sugerida:** Documentar no JSDoc que os métodos **podem rejeitar** em falha de infraestrutura (não engolem erro) e que `reserve` só rejeita por falha técnica — a "insuficiência" é sempre `{ ok:false }`, nunca exceção. Isso já é o comportamento atual; torná-lo contratual evita que um adaptador futuro lance `InsufficientStockError` e quebre os consumidores.

---

## LOW

### L1 — Duplicação estrutural entre `ReserveOutcome` (porta) e `ReservationResult` (domínio)

**Local:** linhas 3-6 (`ReserveOutcome`).

**Descrição:** `ReserveOutcome { ok, remaining }` é estruturalmente idêntico a `ReservationResult` em `src/domain/stock.ts:8-11`. São dois tipos com o mesmo shape, mapeados manualmente no `in-memory-stock.adapter.ts:28` (`{ ok: result.ok, remaining: result.remaining }`).

**Impacto:** Duplicação de baixa gravidade; um divergir do outro no futuro (ex.: adicionar campo a um) silenciosamente quebra o mapeamento. Manutenção levemente mais cara.

**Correção sugerida:** Manter a separação é defensável (a porta é da camada de aplicação, o tipo de domínio é puro). Se preferir reduzir ruído, deixe a porta reexportar/derivar do tipo de domínio, ou documente que a duplicação é intencional (fronteira de camada).

---

### L2 — `remaining` em `ReserveOutcome` não documenta seu significado em caso de falha

**Local:** linhas 3-6.

**Descrição:** Quando `ok:false`, `remaining` carrega o saldo atual (não alterado) — vide domínio `:14-15`. Isso não está documentado no tipo. Um consumidor poderia assumir que `remaining` em falha é `0` ou indefinido.

**Impacto:** Ambiguidade menor de interpretação do campo.

**Correção sugerida:** Adicionar JSDoc nos campos:

```ts
export interface ReserveOutcome {
  /** true se a reserva foi efetivada. */
  ok: boolean;
  /** Saldo após a operação; em falha (ok:false) é o saldo atual inalterado. */
  remaining: number;
}
```

---

### L3 — Comentário do contrato acopla a descrição a tecnologias específicas (Redis/Node)

**Local:** linhas 8-12 (JSDoc da interface).

**Descrição:** O JSDoc da porta menciona "redis: conditional Lua DECRBY" e "memory: Node single-thread". Uma porta hexagonal idealmente descreve a **garantia abstrata** (atomicidade check-and-decrement) sem nomear adaptadores concretos.

**Impacto:** Vazamento conceitual leve: a porta "conhece" seus adaptadores. Não quebra nada, mas enfraquece a inversão de dependência documental.

**Correção sugerida:** Reescrever o JSDoc em termos de garantia: "`reserve` DEVE ser atômico (check-and-decrement indivisível) mesmo sob concorrência entre instâncias." Mover exemplos de implementação para o JSDoc de cada adaptador.

---

### L4 — Contrato não declara idempotência de `init` nem unidade de `quantity`

**Local:** linha 15 (`init`).

**Descrição:** `init` "seta o saldo" (idempotente/sobrescreve), confirmado em ambos os adaptadores (`set`/`Map.set`). Mas o JSDoc diz "Initializes/sets" sem fixar se reinvocar zera o saldo (sobrescreve) ou acumula. Operacionalmente importa: um seed repetido **descarta** reservas em andamento.

**Impacto:** Risco operacional de reset acidental de estoque caso alguém reexecute o seed em produção. Comportamento correto, mas não contratado.

**Correção sugerida:** JSDoc explícito: "`init` define o saldo absoluto (sobrescreve qualquer valor existente). NÃO é seguro chamar com tráfego ativo — descarta reservas em curso."

---

## Pontos positivos

- **Separação de responsabilidades exemplar:** a porta vive na camada de aplicação, sem qualquer import de infraestrutura (ioredis, NestJS), aderindo à arquitetura hexagonal.
- **Token de DI via `Symbol`** (`STOCK_PORT`) — idiomático para NestJS, evita colisão de string e acoplamento à classe concreta. Usado corretamente com `@Inject(STOCK_PORT)` nos três consumidores.
- **`reserve` retorna outcome em vez de lançar** para o caso de negócio "insuficiente" — bom design: o caminho de insuficiência é fluxo de controle normal, não exceção, e fica explícito no consumidor (`checkout.usecase.ts:110`).
- **Método `release` separado** como operação de compensação explícita modela bem o padrão saga/compensação usado no worker e na reconciliação.
- Interface mínima e coesa: quatro operações, sem métodos especulativos.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto e bem posicionado arquiteturalmente; não há bug de runtime nele. As ressalvas (todas MEDIUM/LOW) são sobre **endurecer o contrato via documentação/tipos** para eliminar as divergências implícitas hoje espalhadas pelos adaptadores: domínio de `quantity` (inteiro não-negativo), semântica de produto inexistente, comportamento de falha de infraestrutura e idempotência de `init`. Endereçar M1–M3 no JSDoc (e, opcionalmente, com branded types) transforma garantias hoje implícitas em contrato verificável, sem alterar comportamento.
