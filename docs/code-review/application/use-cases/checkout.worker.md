# Code Review — src/application/use-cases/checkout.worker.ts

## Resumo

Worker assíncrono de checkout bem estruturado: idempotência por estado terminal, observabilidade
correta (timers em `finally`, spans, correlation), aderência limpa à arquitetura hexagonal (só consome
ports, zero infra). Os pontos de atenção são de **concorrência/atomicidade**: o guard anti-duplo-faturamento
em PROCESSING tem uma janela de corrida real (TOCTOU) e o `save()` não tem locking otimista, abrindo espaço
para faturamento duplicado no ERP e para perda de atualização (lost update) na compensação.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 1 |
| HIGH       | 2 |
| MEDIUM     | 3 |
| LOW        | 3 |

---

## CRITICAL

### C1 — Guard anti-duplo-faturamento não fecha a janela de corrida (TOCTOU) → possível dupla fatura no ERP

**Local:** linhas 57-77 (especialmente 64-69 e 71-77).

**Descrição:**
O fluxo é: `findById` → checa `isTerminal` / `PROCESSING` → `transition(PROCESSING)` → `save` → `erp.invoice`.
Entre o `findById` (read) e o `save` (write) não há nenhuma operação atômica (compare-and-swap / lock /
update condicional). O `OrderRepositoryPort.save` (ver `in-memory-order.repo.ts:8-11`) é um overwrite cego
do mapa: não recebe versão esperada nem aborta se o estado mudou.

Cenário de corrida com duas entregas do mesmo job (BullMQ concurrency > 1, redelivery, ou retry concorrente):

1. Worker A: `findById` → status `PENDING`, `attempts = 0`.
2. Worker B: `findById` → status `PENDING`, `attempts = 0` (lê antes de A persistir).
3. Worker A: `save(PROCESSING)`; depois `erp.invoice`.
4. Worker B: o guard da linha 64 (`status === PROCESSING && attempt === order.attempts`) **não dispara**,
   porque B ainda enxerga o snapshot `PENDING` que leu no passo 2. B segue para `save(PROCESSING)` e
   `erp.invoice` → **segunda fatura emitida no ERP para o mesmo pedido**.

O comentário das linhas 61-63 reconhece o risco mas a proteção é insuficiente: ela só funciona quando o
segundo worker lê *depois* que o primeiro já gravou PROCESSING. Como leitura e escrita não são atômicas, a
janela permanece aberta. Além disso, o ERP (`ErpPort.invoice`) não expõe chave de idempotência, então o
provider não consegue deduplicar do lado dele.

**Impacto:**
Faturamento duplicado é um defeito financeiro/contábil grave em e-commerce (cobrança e nota fiscal em
duplicidade, divergência com o ERP, necessidade de estorno manual). É o oposto da garantia que o nome da
classe ("Idempotent") promete.

**Correção sugerida:**
Tornar a transição PENDING→PROCESSING uma operação atômica de "claim" no repositório, em vez de
read-then-write. Opções:

- Adicionar ao port um update condicional / CAS, ex.:
  `claimForProcessing(orderId, expectedStatus, attempt): Promise<Order | null>` que só transiciona se o
  estado atual for o esperado, retornando `null` quando outro worker já reivindicou. No Redis/BullMQ isso
  vira um Lua script ou um `WATCH/MULTI`; no SQL, um `UPDATE ... WHERE status = 'PENDING' RETURNING *`.
- Alternativa mínima: introduzir locking otimista por versão (campo `version`) e fazer `save` rejeitar
  quando a versão diverge (ver C/H abaixo), tratando o conflito como "outro worker já assumiu".
- Em paralelo, propagar uma chave de idempotência (`order.idempotencyKey` já existe no domínio) para
  `erp.invoice`, de forma que o ERP também deduplique. Defesa em profundidade.

```ts
const claimed = await this.orders.claimForProcessing(order.id, OrderStatus.PENDING, attempt);
if (!claimed) {
  this.logger.warn(`Pedido ${order.id} já reivindicado por outro worker; ignorando`);
  return;
}
// segue para invoice usando `claimed`
```

---

## HIGH

### H1 — `save()` sem locking otimista: lost update entre `onExhausted` e `process`/reconciliação

**Local:** linhas 77, 87, 113 (todos os `orders.save`) combinados com `in-memory-order.repo.ts:8-11`.

**Descrição:**
Todos os `save` gravam o objeto inteiro por cima do anterior, sem checar se o estado mudou desde o
`findById`. Além do cenário de C1, há um lost update entre `onExhausted` e um retry tardio de `process`:

- `process` (attempt N) lê o pedido, faz `save(PROCESSING)` e chama `erp.invoice` (lento).
- A fila considera as tentativas esgotadas e dispara `onExhausted` concorrentemente: lê o pedido, faz
  `save(FAILED)` e **libera o estoque** (linhas 116-118).
- A chamada `erp.invoice` em `process` retorna com sucesso e executa `save(CONFIRMED)` (linha 87), que
  **sobrescreve o FAILED**.

Resultado: pedido fica `CONFIRMED` mas o estoque já foi devolvido pela compensação → **venda confirmada sem
baixa de estoque** (oversell na prática). O `transition` valida a máquina de estados sobre o snapshot *lido*,
não sobre o estado *persistido no momento da escrita*, então não protege contra isso.

**Impacto:**
Inconsistência estoque×pedido, oversell, e estado final logicamente impossível (CONFIRMED após FAILED).

**Correção sugerida:**
Locking otimista de verdade no port de persistência: `save` deve receber a versão esperada (ou o port deve
oferecer um `compareAndSave`) e falhar em conflito; o worker então re-lê e reavalia. Isso fecha tanto C1
quanto H1. Em memória, comparar `updatedAt`/`version` antes de gravar; em SQL, `WHERE version = :expected`.

### H2 — Compensação não trata falha de `release`: estoque pode ficar permanentemente reservado

**Local:** linhas 116-118.

**Descrição:**
`Promise.all(order.items.map((item) => this.stock.release(...)))`. Se *qualquer* `release` rejeitar (Redis
indisponível, timeout), o `Promise.all` rejeita inteiro. Como `onExhausted` é chamado pela fila no evento de
"attempts exhausted", essa rejeição normalmente não tem mais retry associado — não há nenhum `catch` aqui nem
mecanismo de re-tentativa da compensação. Pior: com `Promise.all`, parte dos itens pode já ter sido liberada
e os demais não, deixando compensação **parcial** sem registro de qual item falhou.

**Impacto:**
Estoque reservado nunca devolvido (perda de disponibilidade de venda) e/ou compensação parcial silenciosa.
A linha 120 ainda loga "estoque compensado" mesmo quando a compensação falhou no meio (a mensagem só não
sai porque o throw aborta — mas então o pedido fica FAILED *sem* estoque devolvido e sem alarme claro).

**Correção sugerida:**
Tornar a compensação resiliente e observável: usar `Promise.allSettled`, logar/metrificar cada `release` que
falhar, e encaminhar para uma DLQ/retry de compensação ou incrementar uma métrica de "compensação pendente"
para reconciliação posterior. Idealmente `release` deve ser idempotente para permitir re-tentativa segura.

```ts
const results = await Promise.allSettled(
  order.items.map((i) => this.stock.release(i.productId, i.quantity)),
);
const failures = results.filter((r) => r.status === 'rejected');
if (failures.length) {
  this.metrics.workerJobs.inc({ result: 'compensation_failed' });
  this.logger.error(`Compensação parcial do pedido ${order.id}: ${failures.length} item(ns) não liberados`);
  // encaminhar para reconciliação/DLQ
}
```

---

## MEDIUM

### M1 — `attempt` sobrescreve `order.attempts` cegamente, podendo regredir o contador

**Local:** linha 72 (`{ ...order, attempts: attempt }`) e linha 64.

**Descrição:**
O código adota `attempt` (vindo da fila) como verdade absoluta de `attempts`, sobrescrevendo o valor
persistido. Se a fila reentregar com um `attempt` menor/igual ao já registrado (redelivery, semântica de
numeração específica do broker), o contador pode estagnar ou regredir. Além disso o guard da linha 64 usa
igualdade exata `attempt === order.attempts`; qualquer descompasso na convenção de numeração entre broker e
persistência enfraquece o guard (que já é frágil por C1).

**Impacto:**
Contador de tentativas (usado para observabilidade e reconciliação, conforme doc do domínio) potencialmente
incorreto; guard de duplicidade dependente de uma igualdade frágil.

**Correção sugerida:**
Usar `Math.max(order.attempts, attempt)` ou incremento monotônico controlado pelo próprio worker, e basear o
guard de duplicidade no claim atômico (C1) em vez da igualdade de `attempt`.

### M2 — `(err as Error).message` assume que o throw é sempre um `Error`

**Local:** linha 93 (e implicitamente o `throw err` da 95; também o `error.message` na 111, que é tipado).

**Descrição:**
`erp.invoice` é um port externo; um adapter pode rejeitar com algo que não é `Error` (string, objeto, valor
do driver). O cast `(err as Error).message` resultaria em `undefined` no log, perdendo a causa real. A pilha
(`err.stack`) também não é logada — só `.message` — dificultando o diagnóstico.

**Impacto:**
Log de falha pobre/enganoso ("Falha ao faturar ... undefined"), perda de stack trace para troubleshooting de
um ponto que é justamente o "ofensor #3" (ERP lento/instável) do estudo de caso.

**Correção sugerida:**
Normalizar o erro: `const e = err instanceof Error ? err : new Error(String(err));` e logar `e.message` +
`e.stack` (ou passar o objeto de erro ao logger do Nest, que aceita o trace como 2º argumento).

### M3 — Métrica `queueDepth` consultada no `finally` pode mascarar a exceção do job

**Local:** linhas 43-46.

**Descrição:**
No `finally`, `this.queue.depth()` é aguardado. Se `depth()` rejeitar (Redis fora), a rejeição do `finally`
**substitui** a exceção original de `handle` (a do ERP), quebrando o mecanismo de retry/backoff: a fila
receberá o erro de `depth()` em vez do erro real de faturamento, e o motivo do retry fica obscurecido. Também
é um `await` extra no caminho quente de todo job só para atualizar um gauge.

**Impacto:**
Possível perda da exceção de negócio (a que deve disparar retry) e ruído na causa de falha; custo de uma
chamada Redis por job.

**Correção sugerida:**
Proteger a atualização da métrica para nunca sobrepor o fluxo de erro: envolver em `try/catch` próprio (ou
`.catch(() => {})`), e considerar atualizar `queueDepth` fora do caminho de cada job (ex.: scrape periódico).

```ts
} finally {
  endTimer();
  try { this.metrics.queueDepth.set(await this.queue.depth()); } catch { /* gauge best-effort */ }
}
```

---

## LOW

### L1 — `new Date().toISOString()` repetido por transição (relógio não injetado)

**Local:** linhas 74, 84, 110.

**Descrição:** O timestamp é gerado inline via `new Date()`, acoplando o caso de uso ao relógio do sistema.
Dificulta testes determinísticos do histórico de transições e gera múltiplas leituras de relógio por job.

**Correção sugerida:** Injetar um `Clock`/`now()` port (ou capturar `const now = new Date().toISOString()`
uma vez por `handle`) para testabilidade e consistência do histórico dentro de uma mesma operação.

### L2 — Log de `onExhausted` pode não alcançar pedidos já terminais sem sinal

**Local:** linha 105 (`if (!order || isTerminal(order.status)) return;`).

**Descrição:** O early-return silencioso é correto para idempotência, mas quando `onExhausted` cai num pedido
já CONFIRMED (vide H1) não há log/métrica registrando que a compensação foi pulada. Some-se a isso o risco de
H1 e fica difícil detectar o estado inconsistente em produção.

**Correção sugerida:** Emitir ao menos um `debug`/métrica quando `onExhausted` ignora por estado terminal,
para auditabilidade.

### L3 — Mensagens de log misturam idioma e usam ora `order.id` ora `job.orderId`

**Local:** linhas 54, 58, 66, 89, 93, 120 (PT-BR) vs. comentários e nomes em inglês; uso de `job.orderId`
(54) vs `order.id` (58, 89...).

**Descrição:** Inconsistência de idioma (mensagens em português, código/comentários em inglês) e de fonte do
id. Puramente cosmético/manutenção, mas convém padronizar para facilitar busca em logs.

**Correção sugerida:** Padronizar idioma das mensagens de log e sempre referenciar o mesmo campo de id.

---

## Pontos positivos

- **Hexagonal limpa:** o caso de uso depende exclusivamente de ports (`QueuePort`, `ErpPort`,
  `OrderRepositoryPort`, `StockPort`) e de funções puras do domínio (`transition`, `isTerminal`); zero
  vazamento de infraestrutura. Excelente aderência arquitetural.
- **Observabilidade exemplar:** `endTimer()` em `finally`, spans nomeados, contadores de resultado
  (`confirmed`/`retried`/`failed`), métricas de ERP com sucesso/erro e `runWithCorrelation` propagando o
  `correlationId` ponta a ponta.
- **Idempotência básica correta:** early-returns para pedido inexistente e para estado terminal estão certos
  e bem comentados; `transition` é idempotente quando já no estado-alvo.
- **Erro de faturamento re-lançado** (linha 95) para a fila tratar retry/backoff — separação correta entre
  retry transitório e falha definitiva (`onExhausted`).
- **Uso de função pura `transition`** mantém a máquina de estados validada e o `Order` imutável.

---

## Veredito

**Requer mudanças.**

O design de observabilidade e a aderência hexagonal são exemplares, mas o objetivo central do worker —
faturar **exatamente uma vez** e manter estoque×pedido consistentes — não está garantido sob concorrência.
O guard anti-duplicidade é um check TOCTOU sobre um `save` sem CAS (C1), e a interação `process`×`onExhausted`
pode produzir CONFIRMED-após-FAILED com estoque já liberado (H1). A compensação não tolera falha parcial (H2).
Recomendo: introduzir claim atômico / locking otimista no `OrderRepositoryPort`, propagar idempotência ao ERP,
e tornar a compensação resiliente (`allSettled` + reconciliação) antes de aprovar. Não há teste para este
worker — adicionar cobertura dos cenários de corrida é fortemente recomendado.
