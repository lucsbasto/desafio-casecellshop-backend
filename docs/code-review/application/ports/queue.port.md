# Code Review — src/application/ports/queue.port.ts

## Resumo

Arquivo de **porta** (contrato) puro, sem lógica executável: define `QUEUE_PORT`, `CheckoutJob`, `QueueProcessor` e `QueuePort`. É enxuto, idiomático e bem documentado, com aderência correta à arquitetura hexagonal (não vaza tipos de infra como BullMQ/Job/Redis para o domínio). Os achados são de **design de contrato**: o contrato é frouxo o suficiente para admitir divergências reais já observadas entre os dois adapters (semântica do `attempt`, ausência de chave de deduplicação, garantias de `register`/`enqueue` não especificadas).

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 4          |
| LOW        | 4          |

---

## HIGH

### H1 — Semântica de `attempt` não especificada no contrato; adapters divergem

**Local:** linha 15 (`process(job: CheckoutJob, attempt: number)`).

**Descrição:** O contrato declara `attempt: number` sem definir o domínio do valor (base-0 ou base-1, quando incrementa, o que significa "primeira execução"). Os dois adapters produzem o valor de formas diferentes:
- `BullMqQueueAdapter` (linha 63): `processor.process(job.data, job.attemptsMade + 1)` — `attemptsMade` no BullMQ é o número de tentativas **já feitas** e tem semântica própria entre tentativas/retries.
- `InMemoryQueueAdapter` (linhas 54-66): controla `attempt` localmente, começando em `1` e incrementando após o `sleep`.

Esse valor não é decorativo: o worker o usa em lógica de correção de concorrência — `checkout.worker.ts` linha 64: `if (order.status === OrderStatus.PROCESSING && attempt === order.attempts)`. Uma divergência de 1 na contagem entre adapters muda o comportamento dessa guarda anti-double-invoice (pode deixar passar um job duplicado ou bloquear um retry legítimo).

**Impacto:** O mesmo `CheckoutWorker` se comporta diferente sob Redis vs memória. Como a guarda protege contra **dupla fatura no ERP** (efeito colateral financeiro irreversível), uma divergência de contagem é um risco de correção de negócio, não só cosmético. Testes em memória podem "passar" enquanto produção (Redis) diverge.

**Correção sugerida:** Documentar a semântica exata no contrato e garantir que ambos adapters a respeitem. Ex.:

```ts
export interface QueueProcessor {
  /**
   * @param attempt 1-based: 1 na primeira execução, incrementa a cada retry.
   *   DEVE corresponder ao número da tentativa atual, não a tentativas já feitas.
   */
  process(job: CheckoutJob, attempt: number): Promise<void>;
  onExhausted(job: CheckoutJob, error: Error): Promise<void>;
}
```

Idealmente trocar o `number` cru por um tipo nomeado (`type Attempt = number & { readonly __brand: 'Attempt' }`) ou ao menos um teste de contrato compartilhado que rode os dois adapters contra as mesmas asserções de `attempt`.

---

## MEDIUM

### M1 — `CheckoutJob` não carrega chave de deduplicação / idempotência da fila

**Local:** linhas 3-7 (`CheckoutJob`).

**Descrição:** O job só transporta `orderId` e `correlationId`. Não há `jobId`/dedupe key. No BullMQ, `queue.add('process-checkout', job, ...)` (adapter linha 51) sem `jobId` gera IDs distintos a cada chamada. Como a reconciliação reenfileira pedidos PENDING órfãos (`reconcile.usecase.ts` linha 57), é possível ter **dois jobs ativos para o mesmo `orderId`** simultaneamente (entrega original tardia + reenfileiramento). A defesa hoje é apenas a guarda de estado no worker (`order.status === PROCESSING`), que é uma checagem read-then-act sujeita a corrida sob `concurrency: 4`.

**Impacto:** Aumenta a janela de processamento concorrente do mesmo pedido, exatamente o cenário de dupla fatura que o worker tenta mitigar. A deduplicação no nível da fila (mais barata e robusta) está ausente do contrato.

**Correção sugerida:** Permitir uma chave de deduplicação no contrato e usá-la como `jobId` no BullMQ:

```ts
export interface CheckoutJob {
  orderId: string;
  correlationId: string;
}
// no adapter: this.queue.add('process-checkout', job, { jobId: `checkout:${job.orderId}`, ... })
```

Usar `orderId` como `jobId` faz o BullMQ rejeitar duplicatas naturalmente. Documentar essa garantia no JSDoc da porta.

### M2 — Tipo de erro fixado em `Error` empobrece `onExhausted`

**Local:** linha 16 (`onExhausted(job: CheckoutJob, error: Error)`).

**Descrição:** O contrato fixa `error: Error`. Erros em JS podem ser `unknown` (qualquer valor `throw`). No `InMemoryQueueAdapter` linha 62 há um cast `err as Error` para satisfazer o tipo; um `throw 'string'` ou rejeição não-`Error` viola o contrato silenciosamente e pode quebrar `onExhausted` (que faz `error.message` em `checkout.worker.ts` linha 111). Além disso, `Error` não expõe `code`/`cause`, perdendo a capacidade de o consumidor distinguir falhas (ex.: erro transitório vs permanente) na compensação.

**Impacto:** Asserção de tipo insegura empurrada para os adapters; potencial `undefined`/exceção dentro da compensação (que, se falhar, deixa estoque reservado — overselling oculto).

**Correção sugerida:** Aceitar `unknown` e normalizar, ou tipar como `Error & { cause?: unknown }`. Mínimo: `onExhausted(job: CheckoutJob, error: unknown): Promise<void>` e normalização no consumidor. Documentar que o adapter garante passar sempre uma instância de `Error`.

### M3 — `register` não especifica garantia de chamada única / idempotência

**Local:** linha 28 (`register(processor: QueueProcessor): void`).

**Descrição:** O JSDoc diz "Called once during worker bootstrap", mas é só comentário — o contrato não impede chamadas múltiplas. Em `BullMqQueueAdapter.register` (linha 60), cada chamada cria um **novo `Worker`** e sobrescreve `this.worker` sem fechar o anterior, vazando uma conexão/worker Redis e duplicando o consumo (dois workers processando a mesma fila). O `InMemoryQueueAdapter` apenas sobrescreve `this.processor` (mais benigno, mas ainda silencioso).

**Impacto:** Em cenários de reinicialização de módulo/HMR/testes que reinstanciam o worker, vaza recursos e pode duplicar processamento. O contrato não dá ao implementador a obrigação de tratar isso.

**Correção sugerida:** Documentar a pré-condição como invariante imposta ("DEVE ser chamado no máximo uma vez; implementações DEVEM lançar ou substituir de forma segura em chamadas subsequentes") e, no adapter BullMQ, fechar o worker anterior ou lançar se já registrado.

### M4 — Ausência de contrato de robustez/idempotência para `enqueue`

**Local:** linha 26 (`enqueue(job: CheckoutJob): Promise<void>`).

**Descrição:** `enqueue` retorna `Promise<void>` sem semântica definida sobre: (a) at-least-once vs exactly-once, (b) o que significa a resolução da promise (aceito durável vs em buffer), (c) idempotência ao reenfileirar o mesmo `orderId`. O `CheckoutUseCase` (linha 143) e o `ReconcileUseCase` (linha 57) dependem implicitamente de comportamentos diferentes (o outbox lógico assume que falha de enqueue é recuperável por reconciliação), mas isso é conhecimento tribal nos comentários, não no contrato.

**Impacto:** Implementações futuras da porta podem violar suposições não escritas (ex.: um adapter que faz fire-and-forget bufferizado quebraria a premissa de "salvar PENDING antes de enfileirar = outbox"). Acoplamento a comportamento não especificado.

**Correção sugerida:** Documentar no JSDoc as garantias mínimas: "resolve somente após o job estar durável na fila; entrega at-least-once; reenfileirar o mesmo orderId é seguro (deduplicado por jobId)". Ver M1.

---

## LOW

### L1 — Falta `Promise<void>` explícito de retorno em `register`? Não — mas `register` síncrono mistura estilos

**Local:** linha 28.

**Descrição:** `register` é síncrono (`void`) enquanto o resto da porta é assíncrono. Em `BullMqQueueAdapter` a criação do `Worker` é efetivamente assíncrona (conexão Redis estabelecida em background), de modo que `register` "termina" antes do worker estar pronto. Não há como o chamador aguardar prontidão.

**Impacto:** Baixo; o bootstrap do Nest tolera. Mas dificulta health-checks de prontidão do worker.

**Correção sugerida:** Considerar `register(processor): Promise<void>` se prontidão do consumidor vier a importar; caso contrário, documentar explicitamente que `register` é "fire-and-forget, prontidão não garantida".

### L2 — `depth()` sem semântica definida (o que conta como "profundidade")

**Local:** linha 30 (`depth(): Promise<number>`).

**Descrição:** O JSDoc diz "Current queue depth" mas não define se inclui delayed/active/waiting. O BullMQ soma `waiting + active + delayed` (adapter linhas 89-90); o in-memory retorna `pending` (jobs em voo, incluindo os que dormem no backoff). São definições diferentes de "depth", e a métrica `queue_depth` mistura as duas conforme o ambiente.

**Impacto:** Métrica comparável entre ambientes só por coincidência; alertas baseados em `queue_depth` podem ter limiares inválidos ao trocar de adapter.

**Correção sugerida:** Documentar exatamente quais estados `depth()` deve somar para manter a métrica consistente entre implementações.

### L3 — Nome `onExhausted` acopla o contrato a um detalhe de "tentativas"

**Local:** linha 16.

**Descrição:** O nome assume um modelo de retry baseado em "tentativas esgotadas". É adequado hoje, mas o contrato seria mais durável com algo como `onDeadLetter`/`onFailedTerminally`, desacoplando do mecanismo (poderia ser timeout, circuito aberto etc.).

**Impacto:** Cosmético / evolutivo.

**Correção sugerida:** Renomear para `onDeadLetter` se houver apetite; do contrário, manter e documentar que "exhausted" = qualquer falha terminal, não só esgotamento de tentativas.

### L4 — JSDoc menciona BullMQ/Redis na porta (vazamento conceitual de infra)

**Local:** linhas 9-13 e 19-24.

**Descrição:** Os comentários da porta citam `BullMQ`, `'failed' event`, `attemptsMade`, `DLQ`. Embora não vaze em *tipos*, vaza em *documentação*: a porta deveria descrever o contrato em termos de domínio, não da implementação Redis específica. Isso engessa a porta a uma tecnologia.

**Impacto:** Baixo; puramente conceitual / manutenibilidade. Pode confundir um implementador de adapter alternativo (ex.: SQS, Kafka) achando que precisa replicar conceitos BullMQ.

**Correção sugerida:** Reescrever o JSDoc em termos neutros (retry/backoff/dead-letter) e mover a nota "Maps directly to BullMQ" para o adapter BullMQ, onde é apropriada.

---

## Pontos positivos

- Aderência hexagonal correta nos **tipos**: nenhum import de infra (`bullmq`, `ioredis`, `@nestjs/*`) — a porta é dependível pelo domínio/aplicação sem acoplamento.
- Uso do token `Symbol('QUEUE_PORT')` (linha 1) é idiomático em NestJS para DI baseada em interface, evitando colisão de strings.
- `correlationId` no job (linhas 5-6) preserva rastreabilidade ponta-a-ponta para o worker — bem pensado para observabilidade.
- Interface mínima e coesa: `enqueue`/`register`/`depth`/`close` cobrem exatamente o ciclo de vida necessário (incluindo shutdown gracioso).
- A separação `process` (retry-able) vs `onExhausted` (terminal/compensação) modela bem o fluxo de resiliência.
- JSDoc presente e (apesar de L4) informativo sobre a intenção de "outbox lógico".

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é um contrato sólido e bem posicionado na arquitetura. Não há defeitos CRITICAL — por ser uma interface pura, não executa nada. Porém o achado **H1 (semântica de `attempt` indefinida)** é real e tem consequência de negócio (dupla fatura sob concorrência), pois o contrato frouxo permite a divergência observada entre os dois adapters. Recomenda-se, antes do merge: (1) especificar a semântica de `attempt` e cobri-la com um teste de contrato compartilhado entre adapters; (2) endereçar M1/M3 (dedupe key + garantia de `register` único) que reforçam a prevenção de processamento duplicado. Os MEDIUM restantes e os LOW podem ser tratados como hardening incremental do contrato.
