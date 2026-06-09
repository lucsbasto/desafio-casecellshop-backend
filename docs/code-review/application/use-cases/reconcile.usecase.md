# Code Review — src/application/use-cases/reconcile.usecase.ts

## Resumo

A reconciliação é simples e legível, mas tem uma falha de **atomicidade/concorrência relevante**: ela age sobre um snapshot obtido em `findPendingOlderThan` sem re-leitura nem lock, podendo colidir com o worker (double-release de estoque / oversell) e abortar a varredura inteira com `InvalidOrderTransitionError`. Há ainda risco de loop infinito de re-enfileiramento para `createdAt` inválido e ausência de teste.

| Severidade | Qtde |
|-----------|------|
| CRITICAL  | 1    |
| HIGH      | 3    |
| MEDIUM    | 3    |
| LOW       | 3    |

---

## CRITICAL

### C1 — Race com o worker no caminho FAILED: double-release de estoque / order CONFIRMED com estoque devolvido
**Local:** linhas 36, 40-54 (especialmente 42-53)

**Descrição:** O caso lê `candidates` em `findPendingOlderThan(ageCutoff)` (linha 36) e, no loop, transiciona `order` (snapshot **stale**) para `FAILED` e libera o estoque (`stock.release`) **sem re-ler o pedido nem usar lock/CAS**. Entre a varredura e o `save`, o `CheckoutWorker` pode ter pego o mesmo `orderId`:

- Worker move PENDING→PROCESSING e está faturando no ERP; reconcile (com snapshot PENDING) faz `transition(order, FAILED)` — como `transition` opera sobre o snapshot stale (status PENDING), a validação da máquina de estados passa (`PENDING→FAILED` é permitido) e o `save` **sobrescreve** o PROCESSING/CONFIRMED do worker. Resultado: pedido faturado no ERP marcado como FAILED **e estoque devolvido** (`release`), causando oversell na próxima reserva.
- Inversamente, worker (`onExhausted`) e reconcile podem ambos chamar `stock.release` para o mesmo pedido → **double-release** (estoque incrementado em dobro → oversell garantido).

Note que `transition` (domain/order.ts:60-71) valida contra `order.status` **do objeto em memória**, não contra o estado atual no repositório — logo não há proteção de concorrência aqui; a proteção do worker (`attempt === order.attempts`, worker:64) não cobre o reconcile.

**Impacto:** Corrupção de estado financeiro e de estoque (oversell), o exato cenário "anti ghost-order" que o componente deveria proteger. É a falha mais grave do arquivo.

**Correção sugerida:** Re-ler o pedido imediatamente antes de transicionar e tornar a transição+release condicional/atômica. No mínimo:

```ts
for (const order of candidates) {
  const fresh = await this.orders.findById(order.id);
  if (!fresh || isTerminal(fresh.status) || fresh.status !== OrderStatus.PENDING) {
    continue; // worker já assumiu/finalizou; não interferir
  }
  // ... usar `fresh` daqui em diante
}
```

Idealmente o repositório deveria expor um `save` com compare-and-set (ex.: `saveIf(order, expectedStatus)` / optimistic-lock por `updatedAt`/versão) e o `release` deveria ser idempotente por (orderId, item) para evitar double-release mesmo sob corrida. Sem CAS, a janela de corrida apenas diminui, não fecha.

---

## HIGH

### H1 — `transition` pode lançar e abortar a varredura inteira; sem try/catch por item
**Local:** linhas 40-63 (loop), 44-49

**Descrição:** Se entre a varredura e o processamento um pedido sair de PENDING (worker o levou a PROCESSING/CONFIRMED/FAILED), `transition(order, OrderStatus.FAILED, ...)` lançará `InvalidOrderTransitionError` (order.ts:62-63) — **exceto** quando já estiver em FAILED, em que retorna o mesmo objeto (order.ts:61). Como não há `try/catch` por iteração, uma única exceção **interrompe todo o loop**: os demais candidatos não são processados, o `logger.warn` de resumo e o `metrics.queueDepth.set` (linhas 65-70) não executam, e o `ReconcileReport` não é retornado. Um único pedido em corrida derruba a rodada inteira de reconciliação.

**Impacto:** Reconciliação frágil e não-determinística; pedidos órfãos legítimos deixam de ser tratados por causa de outro pedido. Perde-se também a métrica e o relatório.

**Correção sugerida:** Envolver o corpo do loop em `try/catch`, contabilizar erros (ex.: `errors++`) e continuar. Combinar com C1 (re-leitura) para que a maioria dos casos vire `continue` em vez de exceção:

```ts
let errors = 0;
for (const order of candidates) {
  try {
    // ... lógica
  } catch (err) {
    errors++;
    this.logger.error(`Falha ao reconciliar ${order.id}: ${(err as Error).message}`);
  }
}
```
e expor `errors` no relatório.

### H2 — `createdAt` inválido roteia o pedido para re-enqueue eterno (falha silenciosa)
**Local:** linhas 41-42

**Descrição:** `const createdAt = new Date(order.createdAt)`. Se `order.createdAt` estiver corrompido/ausente, `createdAt` é `Invalid Date`; a comparação `createdAt < maxAgeCutoff` envolve `NaN`, que é sempre `false`. O pedido nunca cai no ramo FAILED — ele é **re-enfileirado em toda rodada de reconciliação, indefinidamente**, sem nunca expirar. Não há validação nem log.

**Impacto:** Loop infinito de re-enqueue para qualquer pedido com timestamp inválido; o pedido nunca atinge estado terminal, escapando da intenção do `RECONCILE_MAX_AGE_MS`. Falha silenciosa difícil de diagnosticar.

**Correção sugerida:** Validar o parse e tratar como anomalia explícita:

```ts
const ts = Date.parse(order.createdAt);
if (Number.isNaN(ts)) {
  this.logger.error(`Pedido ${order.id} com createdAt inválido: ${order.createdAt}`);
  errors++; // ou rota explícita p/ FAILED/DLQ
  continue;
}
const createdAt = new Date(ts);
```

### H3 — Ausência de lock/idempotência da própria reconciliação (execuções concorrentes)
**Local:** classe inteira; agravado por linhas 36, 40-63

**Descrição:** Nada impede duas execuções simultâneas de `execute()` (duas instâncias do scheduler, ou overlap de uma execução longa com a próxima tick do cron). Ambas leem o mesmo conjunto de candidatos e fazem **double-enqueue** (mesmo `orderId`) e/ou **double-release** no caminho FAILED. O `correlationId` fixo `reconcile-${order.id}` (linha 59) não garante de-dup na fila a menos que o adapter use jobId determinístico.

**Impacto:** Sob escala/HA, processamento duplicado e compensação de estoque duplicada — novamente oversell.

**Correção sugerida:** Serializar a reconciliação com um lock distribuído (Redis `SET NX PX`) cobrindo a janela inteira, e/ou usar `jobId` determinístico no enqueue para de-dup nativa do BullMQ (`{ jobId: \`reconcile-${order.id}\` }`). Confirmar no `bullmq-queue.adapter.ts` se `enqueue` propaga jobId.

---

## MEDIUM

### M1 — `save` + `release` não-atômicos: pode persistir FAILED e falhar a compensação (ou vice-versa)
**Local:** linhas 50-53

**Descrição:** No caminho FAILED, `await this.orders.save(failedOrder)` (linha 50) e depois `Promise.all(... stock.release ...)` (linhas 51-53). Se `save` ok e algum `release` rejeitar, a exceção sobe (sem try/catch — ver H1), deixando o pedido FAILED **sem** estoque devolvido. Como o pedido agora é terminal, a próxima rodada (`findPendingOlderThan` só varre PENDING) **não** vai retentar a compensação → estoque preso permanentemente.

**Impacto:** Estoque reservado nunca liberado (subcontagem permanente) para pedidos que falharem a compensação. Inconsistência silenciosa.

**Correção sugerida:** Liberar estoque **antes** do save terminal (a compensação é idempotente se o release for), ou registrar a compensação pendente para retry. Idealmente `release` idempotente por (orderId, productId). Tornar a ordem de operações resiliente a falha parcial e logar.

### M2 — `Promise.all` em `release` aborta no primeiro erro, deixando itens não compensados
**Local:** linhas 51-53

**Descrição:** `Promise.all` rejeita no primeiro `release` que falhar; os demais `release` já disparados não são aguardados/garantidos e itens subsequentes podem não ser liberados. Para compensação, o desejável é tentar **todos** e agregar falhas.

**Impacto:** Compensação parcial de estoque em pedidos multi-item sob falha transitória de um item.

**Correção sugerida:** Usar `Promise.allSettled`, inspecionar rejeições, logar e contabilizar; decidir retry para as que falharam.

### M3 — `metrics.queueDepth.set` e relatório só ocorrem no caminho feliz
**Local:** linhas 65-71

**Descrição:** Tanto o `logger.warn` de resumo quanto `metrics.queueDepth.set(await this.queue.depth())` e o `return` ficam após o loop; qualquer exceção não tratada (H1/H2) os pula. Além disso, o `set` não está em `finally`, então um erro tardio perde a atualização da métrica de profundidade.

**Impacto:** Observabilidade inconsistente justamente quando há problema (que é quando mais importa).

**Correção sugerida:** Mover atualização de métrica/relatório para `finally`, e garantir que o loop não propague (H1). Considerar uma métrica/contador específico de reconciliação (`reconcile_requeued_total`, `reconcile_failed_total`, `reconcile_errors_total`) — hoje só `queueDepth` é tocado.

---

## LOW

### L1 — `await` dentro do loop serializa todo o batch
**Local:** linhas 40-63

**Descrição:** Cada candidato é processado sequencialmente (save/enqueue/release com `await`). Para lotes grandes, a rodada de reconciliação fica lenta e pode estourar a janela do cron (agravando H3 por overlap). É aceitável para batch pequeno, mas vale observar.

**Correção sugerida:** Processar em chunks com concorrência limitada (ex.: `p-limit`) após resolver C1/H1 (a paralelização sem re-leitura/lock amplia a janela de corrida).

### L2 — `correlationId` de reconciliação descarta o correlation original do pedido
**Local:** linha 59

**Descrição:** O re-enqueue usa `correlationId: \`reconcile-${order.id}\``, perdendo o `correlationId` da requisição original (o `Order` não o persiste). Aceitável e até útil para rastrear origem-reconcile, mas quebra a correlação ponta-a-ponta do trace original.

**Correção sugerida:** Se rastreabilidade ponta-a-ponta for desejada, persistir o `correlationId` original no `Order` e reutilizá-lo, ou compor ambos (`reconcile:<orig>`).

### L3 — Ausência de teste unitário para um componente crítico
**Local:** arquivo inteiro (não há `reconcile.usecase.spec.ts`)

**Descrição:** Não existe teste para este caso de uso, apesar de ele tocar estoque/estado terminal. Os ramos de fronteira (`createdAt === maxAgeCutoff`, corrida com worker, createdAt inválido, falha de release) ficam sem rede de segurança.

**Correção sugerida:** Adicionar testes cobrindo: (a) re-enqueue para `ageMs < idade < maxAgeMs`; (b) FAILED+release para idade > maxAgeMs; (c) limite exato `createdAt === maxAgeCutoff` (hoje vai para re-enqueue, pois usa `<`); (d) createdAt inválido (H2); (e) pedido que saiu de PENDING entre scan e save (C1/H1).

---

## Pontos positivos

- Lógica de duas faixas (re-enqueue vs. FAILED+compensação) clara e bem documentada no cabeçalho (linhas 15-19).
- Boa aderência hexagonal: depende apenas de portas (`QueuePort`, `OrderRepositoryPort`, `StockPort`) e da função pura `transition`; sem vazamento de infraestrutura.
- DI idiomática NestJS com tokens `Symbol` e `@Inject`.
- `transition` é pura/imutável e a transição passa `reason` auditável ("reconciliação: PENDING órfão expirado").
- `execute(now = new Date())` injeta o relógio, facilitando teste determinístico.
- `ReconcileReport` tipado e retornado; logging condicional (`if (requeued || failed)`) evita ruído.

---

## Veredito

**Requer mudanças.**

O componente está bem estruturado e idiomático, mas a falta de re-leitura/atomicidade no caminho FAILED (C1) pode corromper estoque e estado financeiro — exatamente o que a reconciliação existe para prevenir. Soma-se a isso a fragilidade do loop sem try/catch (H1), o loop infinito de re-enqueue para `createdAt` inválido (H2) e a ausência de lock entre execuções concorrentes (H3). Recomendo bloquear o merge até endereçar C1 + H1 + H2 (e idealmente H3), além de adicionar os testes (L3).
