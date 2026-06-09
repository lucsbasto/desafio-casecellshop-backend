# Code Review — src/domain/order.spec.ts

## Resumo

Suíte enxuta e correta para a máquina de estados de `Order` (`canTransition`, `isTerminal`, `transition`). Os testes existentes passam e validam o caminho feliz, idempotência e imutabilidade. Porém há lacunas de cobertura comportamental relevantes: as transições de compensação para `FAILED` (rollback de estoque) não são testadas, o invariante anti-double-processing (`PROCESSING -/-> PENDING`) documentado no código-fonte não tem teste de regressão, e asserções de `reason`/`updatedAt` estão ausentes. Nenhum problema de correção no próprio teste — apenas adequação/cobertura.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 2         |
| MEDIUM     | 4         |
| LOW        | 3         |

---

## HIGH

### H1 — Transições para FAILED (caminho de compensação) não testadas
- **Local:** suíte inteira (faltam casos); referência `order.ts:40,43`.
- **Descrição:** `ALLOWED` permite `PENDING -> FAILED` e `PROCESSING -> FAILED`, mas nenhum teste exercita essas transições. Em um checkout com estoque, `FAILED` é o estado que dispara a compensação da reserva de estoque (rollback). É um caminho de negócio crítico.
- **Impacto:** Uma regressão que quebre `PENDING -> FAILED` ou `PROCESSING -> FAILED` (ex.: alguém editar `ALLOWED` por engano) passaria pelo CI sem detecção, potencialmente deixando estoque reservado preso indefinidamente em produção.
- **Correção sugerida:**
```ts
it('permite compensação: PENDING -> FAILED e PROCESSING -> FAILED', () => {
  expect(canTransition(OrderStatus.PENDING, OrderStatus.FAILED)).toBe(true);
  expect(canTransition(OrderStatus.PROCESSING, OrderStatus.FAILED)).toBe(true);

  const pending = makeOrder(OrderStatus.PENDING);
  const failed = transition(pending, OrderStatus.FAILED, new Date().toISOString(), 'erp-timeout');
  expect(failed.status).toBe(OrderStatus.FAILED);
  expect(isTerminal(failed.status)).toBe(true);
});
```

### H2 — Invariante anti-double-processing (PROCESSING -/-> PENDING) sem teste de regressão
- **Local:** falta de caso; referência ao comentário em `order.ts:41-42`.
- **Descrição:** O código-fonte documenta explicitamente uma decisão de segurança de concorrência: `PROCESSING` nunca volta para `PENDING`, para evitar que a reconciliação reenfileire um pedido que já tem um job ativo (double-processing / cobrança/faturamento duplicado). Essa é exatamente a classe de invariante que merece um teste de regressão "negativo", e ele não existe.
- **Impacto:** Se um futuro PR adicionar `PENDING` à lista de `PROCESSING` (parece inofensivo), abre-se uma race condition de processamento duplo. Sem teste, nada barra a mudança.
- **Correção sugerida:**
```ts
it('NÃO permite PROCESSING -> PENDING (guarda anti double-processing)', () => {
  expect(canTransition(OrderStatus.PROCESSING, OrderStatus.PENDING)).toBe(false);
  const processing = makeOrder(OrderStatus.PROCESSING);
  expect(() =>
    transition(processing, OrderStatus.PENDING, new Date().toISOString()),
  ).toThrow(InvalidOrderTransitionError);
});
```

---

## MEDIUM

### M1 — `reason` passado em transition() nunca é asserido
- **Local:** linha 41 (passa `'go'`), linhas 42-44 (asserções).
- **Descrição:** O teste fornece o argumento `reason = 'go'` mas só verifica `status` e `history.length`. O campo `reason` que `transition` grava em `history[1].reason` (`order.ts:69`) fica sem cobertura.
- **Impacto:** A propagação do motivo da transição para o histórico (usado em auditoria/observabilidade) poderia quebrar silenciosamente. Além disso, passar `'go'` sem assertá-lo dá falsa sensação de cobertura.
- **Correção sugerida:**
```ts
const next = transition(o, OrderStatus.PROCESSING, atIso, 'go');
expect(next.history[1]).toMatchObject({ status: OrderStatus.PROCESSING, reason: 'go', at: atIso });
```

### M2 — `updatedAt` não é verificado após a transição
- **Local:** linhas 39-45.
- **Descrição:** `transition` atualiza `updatedAt` para o `at` recebido (`order.ts:68`), mas nenhum teste valida isso nem que `createdAt` permanece intacto.
- **Impacto:** Regressão em `updatedAt` (ex.: esquecer de atualizar, ou sobrescrever `createdAt`) passaria despercebida; isso afeta reconciliação por janela de tempo e ordenação.
- **Correção sugerida:** asserir `expect(next.updatedAt).toBe(atIso)` e `expect(next.createdAt).toBe(o.createdAt)` usando um `at` determinístico distinto do `createdAt`.

### M3 — `isTerminal(OrderStatus.PROCESSING)` não testado
- **Local:** linhas 47-51.
- **Descrição:** `isTerminal` é testado para `CONFIRMED`, `FAILED` (true) e `PENDING` (false), mas não para `PROCESSING` (deveria ser false). Faltam 1 dos 2 estados não-terminais.
- **Impacto:** Cobertura de ramo incompleta; uma mudança que classificasse `PROCESSING` como terminal (impedindo `PROCESSING -> CONFIRMED`) não seria pega aqui.
- **Correção sugerida:** `expect(isTerminal(OrderStatus.PROCESSING)).toBe(false);`

### M4 — Imutabilidade do array `history` original não é verificada em profundidade
- **Local:** linha 44 (só checa `o.status`).
- **Descrição:** O teste "não muta o original" valida apenas `o.status`. `transition` faz spread de `history` (`order.ts:69`), o que é correto, mas o teste não garante que `o.history` continua com length 1 (não foi feito `push` no array original).
- **Impacto:** Se alguém trocar `[...order.history, x]` por `order.history.push(x)`, o `status` do original continuaria intacto e o teste passaria, mascarando uma mutação real do histórico compartilhado.
- **Correção sugerida:** `expect(o.history).toHaveLength(1);` (e idealmente capturar a referência do array antes para garantir que não foi substituída).

---

## LOW

### L1 — Timestamps não-determinísticos em makeOrder e nos casos
- **Local:** linhas 5, 28, 35, 41 (`new Date().toISOString()`).
- **Descrição:** Cada chamada gera um timestamp real. Hoje nenhuma asserção depende de igualdade temporal, então não há flakiness; mas é um cheiro que dificulta testar `updatedAt`/`at` de forma estável (ver M1/M2).
- **Impacto:** Baixo hoje; vira obstáculo ao adicionar asserções temporais. Pode introduzir flakiness se algum dia compararem `createdAt === updatedAt`.
- **Correção sugerida:** usar um ISO fixo, ex.: `const AT = '2026-01-01T00:00:00.000Z';` e parametrizar `makeOrder(status, at = AT)`.

### L2 — Assimetria canTransition vs transition para mesmo estado não documentada por teste
- **Local:** comportamento em `order.ts:53` vs `order.ts:61`.
- **Descrição:** `canTransition(PENDING, PENDING)` retorna `false` (PENDING não está em sua própria lista), porém `transition(order, PENDING, ...)` retorna idempotentemente o mesmo objeto (curto-circuito antes do `canTransition`). Essa assimetria intencional não tem teste que a fixe.
- **Impacto:** Um leitor futuro pode "consertar" a assimetria (ex.: adicionar guard de `isTerminal` antes do short-circuit) e quebrar a idempotência de estados terminais — `transition(confirmed, CONFIRMED)` deveria ser no-op, não erro.
- **Correção sugerida:**
```ts
it('idempotência vale inclusive para estado terminal', () => {
  const c = makeOrder(OrderStatus.CONFIRMED);
  expect(transition(c, OrderStatus.CONFIRMED, new Date().toISOString())).toBe(c);
});
```

### L3 — Código/erro do DomainError não asserido
- **Local:** linhas 28-30.
- **Descrição:** O teste verifica o tipo `InvalidOrderTransitionError`, mas não o `code` (`'INVALID_ORDER_TRANSITION'`) que a camada de interface usa para mapear o HTTP 409. O contrato relevante para o consumidor (filtro de exceção) é o `code`, não só a classe.
- **Impacto:** Baixo; uma troca acidental do `code` quebraria o mapeamento HTTP sem detecção neste nível.
- **Correção sugerida:** `expect(() => ...).toThrow(/INVALID_ORDER_TRANSITION/)` ou capturar o erro e asserir `err.code`.

---

## Pontos positivos
- Testa o trio essencial: caminho feliz (`PENDING -> PROCESSING -> CONFIRMED`), bloqueio de transição inválida em estado terminal, e idempotência.
- Verifica imutabilidade (parcialmente) e crescimento do `history` — boa prática para uma função pura.
- Usa o tipo de erro de domínio (`InvalidOrderTransitionError`) em vez de string/`Error` genérico no `toThrow`, asserção robusta.
- Factory `makeOrder` mantém os casos legíveis e DRY.
- Asserções usam o enum `OrderStatus` em vez de literais mágicos — resistente a refator.
- Nenhum mock — apropriado, já que o alvo é lógica de domínio pura.

---

## Veredito

**Aprovado com ressalvas.** O arquivo está correto e não contém testes frágeis ou enganosos, mas a cobertura comportamental tem lacunas importantes para um domínio de checkout: faltam os caminhos de compensação para `FAILED` (H1) e um teste de regressão para o invariante anti-double-processing explicitamente documentado no código (H2). Recomenda-se adicionar esses casos antes de considerar a suíte completa; os itens MEDIUM/LOW são incrementos de robustez.
