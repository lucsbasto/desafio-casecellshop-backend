# Code Review — src/infrastructure/queue/in-memory-queue.adapter.ts

## Resumo

Adapter de fila em memória bem escrito: retry iterativo (sem recursão), backoff
exponencial compartilhado via `BackoffStrategy`, rastreio de jobs in-flight para
`drain()`/`close()` determinísticos e métrica de profundidade. O ponto frágil é o
tratamento de falha da compensação (`onExhausted`): diferente do adapter BullMQ,
aqui um erro de compensação é silenciosamente engolido, escondendo overselling.
Há também pequenas lacunas de paridade (lifecycle Nest, validação de `maxAttempts`).

| Severidade | Qtde |
|------------|------|
| CRITICAL   | 0    |
| HIGH       | 1    |
| MEDIUM     | 2    |
| LOW        | 3    |

---

## HIGH

### H1 — Falha de compensação (`onExhausted`) é engolida silenciosamente

- **Local:** linhas 38-49 (`enqueue` `.catch(() => undefined)`) combinadas com linha 62 (`await this.processor.onExhausted(...)`).
- **Descrição:** quando as tentativas se esgotam, `run()` chama `await this.processor.onExhausted(job, err)`. Se essa compensação falhar (ex.: `stock.release` ou `orders.save` lançando), a exceção sobe por `run()` e cai no `.catch(() => undefined)` do `enqueue`, sendo descartada sem log, métrica ou alerta. O adapter BullMQ trata exatamente o mesmo caso de forma oposta e explícita (`bullmq-queue.adapter.ts:74-80`), logando "Compensação (onExhausted) falhou..." com stack, justamente porque uma compensação falha significa **estoque permanece reservado = overselling oculto**.
- **Impacto:** quebra de paridade entre os dois drivers de fila para o cenário mais crítico do checkout. Em modo `memory`, uma falha de compensação some sem rastro — exatamente o oposto da intenção documentada ("invokes `onExhausted` (compensation/DLQ)"). Perda de observabilidade sobre overselling.
- **Correção sugerida:** isolar a chamada de `onExhausted` com tratamento próprio e logar de forma ruidosa (idealmente via `Logger` do Nest, como no adapter BullMQ), em vez de deixar o `.catch` genérico do `enqueue` absorver tudo:

```ts
} catch (err) {
  if (attempt >= this.opts.maxAttempts) {
    try {
      await this.processor.onExhausted(job, err as Error);
    } catch (compErr) {
      this.logger.error(
        `Compensação (onExhausted) falhou para o pedido ${job.orderId}: ` +
          `${(compErr as Error).message}`,
        (compErr as Error).stack,
      );
    }
    return;
  }
  ...
}
```

O `.catch(() => undefined)` em `enqueue` continua válido como rede de segurança de
último recurso contra unhandled rejections, mas não deve ser o único tratamento da
falha de compensação.

---

## MEDIUM

### M1 — Sem lifecycle Nest (`OnModuleDestroy`); `close()`/`drain()` nunca é chamado em shutdown

- **Local:** linha 19 (declaração da classe) e linhas 88-90 (`close`).
- **Descrição:** o adapter expõe `close()` mas **não** implementa `OnModuleDestroy`, ao contrário do `BullMqQueueAdapter` (`bullmq-queue.adapter.ts:34,84-86`). Como o provider é criado por `useFactory` (`infrastructure.module.ts:70`), o Nest só chamará `close()` no shutdown se a interface de lifecycle estiver implementada. Hoje, no driver `memory`, um shutdown gracioso não drena jobs in-flight.
- **Impacto:** em produção o driver é Redis, então o efeito é limitado a ambientes/testes que usam `memory` com `enableShutdownHooks`. Ainda assim, é uma inconsistência de contrato entre os dois adapters da mesma porta e pode deixar jobs interrompidos no meio sem flush.
- **Correção sugerida:** implementar `OnModuleDestroy` delegando a `close()`, espelhando o adapter BullMQ:

```ts
export class InMemoryQueueAdapter implements QueuePort, OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
```

### M2 — `maxAttempts <= 0` não é validado; comportamento silenciosamente degradado

- **Local:** linhas 26-32 (construtor) e linha 60 (`if (attempt >= this.opts.maxAttempts)`).
- **Descrição:** `maxAttempts` chega de env sem clamp (`app-config.ts:53`, `num('WORKER_MAX_ATTEMPTS', 3)`). Com `maxAttempts <= 0`, o job ainda roda 1 vez (attempt começa em 1) e, ao primeiro erro, `1 >= 0` é verdadeiro → vai direto para `onExhausted`, sem nenhuma retentativa. Não há retorno claro do contrato "número de tentativas" e nenhum erro/aviso de configuração inválida.
- **Impacto:** configuração inválida (0 ou negativo) degrada silenciosamente a política de retry — nenhuma retentativa, indo direto à compensação. Difícil de diagnosticar em incidente.
- **Correção sugerida:** validar no construtor (ou normalizar) e falhar rápido em config inválida:

```ts
constructor(private readonly opts: InMemoryQueueOptions) {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new Error('InMemoryQueueAdapter: maxAttempts deve ser inteiro >= 1');
  }
  ...
}
```

---

## LOW

### L1 — `enqueue` é fire-and-forget mas a assinatura `Promise<void>` sugere espera

- **Local:** linhas 38-49.
- **Descrição:** `enqueue` é `async` e retorna `Promise<void>`, mas resolve imediatamente após registrar o job (não aguarda `run`). O comportamento é intencional e documentado pela arquitetura "logical outbox" da porta (`queue.port.ts:19-24`), mas o leitor casual pode supor que `await enqueue()` aguarda o processamento.
- **Impacto:** baixo; risco de mal-entendido em manutenção futura. Sem bug funcional.
- **Correção sugerida:** um comentário curto em `enqueue` deixando explícito "fire-and-forget: resolve assim que o job é registrado; o processamento ocorre em background" reduz ambiguidade.

### L2 — `Math.random`/jitter ausente vs. BullMQ; backoff puramente determinístico

- **Local:** linha 65 (`this.backoff.nextDelay(attempt + 1)`).
- **Descrição:** o backoff é exponencial puro, sem jitter. Para uma fila in-process de demonstração isso é aceitável e até desejável (determinismo nos testes), mas em cenário com vários jobs falhando simultaneamente todos retentam no mesmo instante (thundering herd). É uma limitação conhecida, não um defeito.
- **Impacto:** muito baixo neste contexto (driver de fallback/teste). Mencionado apenas para completude.
- **Correção sugerida:** nenhuma ação necessária; se um dia o driver `memory` for usado sob carga real, considerar jitter na `BackoffStrategy` (afetaria ambos os adapters de forma consistente).

### L3 — `drain()` em laço pode girar mais que o necessário; depende de `inFlight` ser populado de forma síncrona

- **Local:** linhas 81-86 e 38-49.
- **Descrição:** `drain()` repete `Promise.allSettled([...inFlight])` enquanto `inFlight.size > 0`. O laço está correto porque `enqueue` adiciona ao `inFlight` de forma síncrona (linha 48) antes de qualquer `await`, então jobs de follow-up enfileirados durante o processamento são capturados na próxima iteração. A corretude depende dessa garantia de sincronicidade — vale um comentário reforçando-a (hoje o comentário na linha 82 explica o "porquê" do laço, mas não a invariante de que `inFlight.add` é síncrono).
- **Impacto:** nenhum bug; apenas robustez de manutenção. Se alguém tornar o `add` assíncrono no futuro, `drain` poderia retornar cedo.
- **Correção sugerida:** manter como está; opcionalmente documentar a invariante "inFlight é populado sincronamente em enqueue, antes de qualquer await".

---

## Pontos positivos

- **Retry iterativo (linhas 51-69):** o comentário e a implementação evitam recursão, então contagens altas de retry não estouram a stack. Decisão deliberada e correta.
- **Auto-remoção de jobs in-flight (linhas 41-44):** o `.finally` remove a própria promise do `Set`, evitando crescimento ilimitado; chave para `drain()`/`close()` funcionarem sem vazamento.
- **`drain()` determinístico (linhas 80-86):** elimina `sleep` nos testes — ótimo para suítes estáveis e rápidas; o laço cobre o caso de jobs que enfileiram follow-ups.
- **Reuso de `BackoffStrategy` (linhas 2, 24, 27-31, 65):** fonte única de verdade do cálculo de backoff, compartilhada conceitualmente com o BullMQ; evita duplicação da fórmula exponencial. O cálculo `nextDelay(attempt + 1)` está alinhado com a semântica documentada da strategy (espera antes da próxima tentativa).
- **`sleep` com curto-circuito (linhas 71-74):** `ms <= 0` retorna `Promise.resolve()`, tornando o backoff instantâneo/determinístico em teste (`backoffMs: 0`) sem agendar timer.
- **Rede de segurança contra unhandled rejection (linhas 45-47):** o `.catch(() => undefined)` impede que um throw inesperado vire unhandled rejection; a intenção é boa (apesar de ofuscar o caso de H1).
- **Aderência hexagonal:** implementa `QueuePort` sem vazar infra para o domínio; nenhuma dependência de NestJS no corpo (DI feita externamente via `useFactory`), mantendo o adapter puro e testável.

---

## Veredito

**Aprovado com ressalvas.**

O adapter é sólido, idiomático e bem documentado, sem bugs de corretude no caminho
feliz nem race conditions na lógica de in-flight/drain. A ressalva relevante é **H1**:
a falha de compensação (`onExhausted`) é engolida silenciosamente, divergindo do
adapter BullMQ e escondendo um risco de overselling — recomenda-se logar de forma
ruidosa antes do merge. **M1** (lifecycle `OnModuleDestroy`) e **M2** (validação de
`maxAttempts`) são melhorias de paridade/robustez recomendadas, porém não bloqueantes
dado que o driver de produção é o BullMQ. Os achados LOW são cosméticos/de documentação.
