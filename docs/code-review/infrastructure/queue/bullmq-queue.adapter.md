# Code Review — src/infrastructure/queue/bullmq-queue.adapter.ts

## Resumo

Adapter BullMQ que implementa `QueuePort` com retry/backoff/DLQ nativos. O código é enxuto, correto no caminho feliz e trata bem o ponto mais crítico (não engole a promise de compensação no `onExhausted`). Os achados são majoritariamente de robustez de lifecycle, concorrência de `register`, e edge cases de conexão/erro — nenhum bug de corrupção de estoque no caminho principal, mas há riscos operacionais reais (worker duplicado, evento `'error'` não tratado, parsing de URL).

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 2          |
| MEDIUM     | 4          |
| LOW        | 4          |

---

## HIGH

### H1 — `register()` pode criar múltiplos Workers e vazar o anterior
- **Local:** linhas 59-66
- **Descrição:** `register` cria um novo `Worker` e o atribui a `this.worker` sem fechar um worker pré-existente. O JSDoc da porta (`queue.port.ts:27`) diz "Called once during worker bootstrap", mas isso é apenas convenção — nada impede uma segunda chamada (ex.: reinicialização de módulo, teste, hot-reload). Uma segunda chamada vaza a conexão Redis do worker anterior e passa a ter **dois workers consumindo a mesma fila**, dobrando concorrência efetiva e abrindo espaço para processamento duplicado.
- **Impacto:** Vazamento de conexão Redis + risco de invoice ERP duplicado (mitigado parcialmente pelo guard de `PROCESSING` no `CheckoutWorker`, mas não é garantia). Falha silenciosa: nada loga nem rejeita a segunda chamada.
- **Correção sugerida:** Tornar idempotente/guardado:
```ts
register(processor: QueueProcessor): void {
  if (this.worker) {
    throw new Error('BullMqQueueAdapter.register already called: worker already registered');
  }
  this.worker = new Worker(/* ... */);
  // ...
}
```
Ou, se reentrância for desejada, fechar o worker anterior antes de recriar.

### H2 — Eventos `'error'` de `Worker`, `Queue` e `QueueEvents` não são tratados
- **Local:** linhas 46-47 (Queue/QueueEvents), 60-66 (Worker)
- **Descrição:** Nenhum dos objetos BullMQ registra um handler `.on('error', ...)`. Em ioredis/BullMQ, erros de conexão (Redis indisponível, reset, auth) são emitidos como evento `'error'`. Um `EventEmitter` sem listener de `'error'` faz o Node lançar `unhandledException` e pode **derrubar o processo**. Além disso, perdas de conexão ficam invisíveis na observabilidade (sem log/métrica).
- **Impacto:** Crash do processo em queda de Redis; ou, no mínimo, falhas de conexão silenciosas sem rastro nos logs — péssimo para um componente de checkout assíncrono.
- **Correção sugerida:**
```ts
this.queue.on('error', (e) => this.logger.error(`Queue error: ${e.message}`, e.stack));
this.events.on('error', (e) => this.logger.error(`QueueEvents error: ${e.message}`, e.stack));
// dentro de register():
this.worker.on('error', (e) => this.logger.error(`Worker error: ${e.message}`, e.stack));
```

---

## MEDIUM

### M1 — Condição de exaustão usa `>=` mas deveria documentar/garantir igualdade exata
- **Local:** linha 71 (`if (job.attemptsMade >= this.opts.maxAttempts)`)
- **Descrição:** No evento `failed`, o BullMQ já incrementou `attemptsMade`. Com `attempts: maxAttempts`, a exaustão ocorre exatamente quando `attemptsMade === maxAttempts`. O `>=` funciona, mas mascara um pressuposto frágil: se `opts.maxAttempts` divergir do `attempts` configurado no `enqueue` (hoje vêm da mesma config, mas são duas leituras independentes — linhas 52 vs 71), a lógica de compensação pode disparar cedo ou nunca. Há também o caso de jobs descartados manualmente / `discard()` em que `attemptsMade` pode não bater.
- **Impacto:** Acoplamento implícito entre dois pontos de configuração. Se um dia `attempts` no `add` for sobrescrito por job, a compensação pode não disparar (estoque preso) ou disparar antes da hora.
- **Correção sugerida:** Preferir o sinal canônico do BullMQ — comparar com `job.opts.attempts` (o valor realmente usado pelo job) em vez de `this.opts.maxAttempts`:
```ts
const maxAttempts = job.opts.attempts ?? this.opts.maxAttempts;
if (job.attemptsMade >= maxAttempts) { /* ... */ }
```

### M2 — `removeOnComplete: 1000` numérico remove por contagem, não por idade — pode não ser a intenção
- **Local:** linha 54
- **Descrição:** `removeOnComplete: 1000` mantém os **últimos 1000 jobs completos**. Em throughput alto isso é pouco histórico; em baixo, retém indefinidamente. Não há `removeOnComplete.age`. Combinado com `removeOnFail: false` (mantém todos os falhos para sempre como DLQ), o Redis pode crescer sem limite na lista de falhos.
- **Impacto:** Crescimento ilimitado da chave de jobs falhos no Redis (memória). Operacionalmente é uma DLQ sem política de retenção/expurgo.
- **Correção sugerida:** Definir política explícita por idade e/ou contagem, e documentar a estratégia de limpeza da DLQ (job de reconcile/purge):
```ts
removeOnComplete: { age: 24 * 3600, count: 1000 },
removeOnFail: { age: 7 * 24 * 3600 }, // DLQ com retenção
```

### M3 — `close()` não é resiliente a falha parcial nem idempotente
- **Local:** linhas 93-97
- **Descrição:** `close()` faz `await` sequencial em `worker.close()`, `events.close()`, `queue.close()`. Se `worker.close()` rejeitar, `events`/`queue` nunca fecham (vazamento de conexão no shutdown). Também não há guarda contra chamada dupla (`onModuleDestroy` + close manual).
- **Impacto:** Shutdown sujo: conexões Redis remanescentes se a primeira etapa falhar; possível erro em close duplo.
- **Correção sugerida:** Usar `Promise.allSettled` e logar falhas individuais:
```ts
const results = await Promise.allSettled([
  this.worker?.close(),
  this.events.close(),
  this.queue.close(),
]);
results.forEach((r) => {
  if (r.status === 'rejected') this.logger.error(`Erro ao fechar recurso da fila: ${r.reason}`);
});
```

### M4 — `toConnection` não valida o esquema da URL nem trata TLS (`rediss://`)
- **Local:** linhas 13-22
- **Descrição:** `new URL(redisUrl)` aceita qualquer esquema; uma URL malformada lança um erro genérico no construtor do adapter (sem contexto). Não há suporte a `rediss://` (TLS), comum em Redis gerenciado (ex.: AWS ElastiCache/Upstash com TLS). `u.username` também é ignorado (Redis 6+ ACL usa user+password). Sem validação, um `redisUrl` errado só falha em runtime longe da origem.
- **Impacto:** Falha de conexão silenciosa/confusa em ambientes com TLS ou ACL; mensagem de erro pouco diagnóstica em URL inválida.
- **Correção sugerida:** Validar esquema, suportar TLS e username:
```ts
const u = new URL(redisUrl);
if (!/^rediss?:$/.test(u.protocol)) {
  throw new Error(`REDIS_URL com esquema inválido: ${u.protocol}`);
}
return {
  host: u.hostname,
  port: Number(u.port || 6379),
  username: u.username || undefined,
  password: u.password ? decodeURIComponent(u.password) : undefined,
  tls: u.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: null,
};
```
(Nota: senha com caracteres especiais já vem URL-encoded; o `decodeURIComponent` corrige isso.)

---

## LOW

### L1 — Concorrência fixa em `4` (magic number, não configurável)
- **Local:** linha 65 (`concurrency: 4`)
- **Descrição:** A concorrência do worker está hardcoded. As demais opções de retry/backoff são configuráveis via `BullMqOptions`, mas a concorrência não. Em produção isso costuma precisar de tuning por ambiente.
- **Impacto:** Falta de flexibilidade operacional; valor mágico sem nome.
- **Correção sugerida:** Expor `concurrency` em `BullMqOptions` (com default 4) e ler de `cfg.worker`.

### L2 — `removeOnComplete: 1000` e nome do job string literal duplicável
- **Local:** linhas 51 (`'process-checkout'`) e a constante `QUEUE_NAME`
- **Descrição:** O nome do job `'process-checkout'` é um literal solto; `QUEUE_NAME` foi extraído para constante, mas o job name não. Consistência: ambos deveriam ser constantes nomeadas para evitar divergência se referenciados em outro lugar (ex.: métricas/filtragem).
- **Impacto:** Baixo; risco de typo se reutilizado.
- **Correção sugerida:** `const JOB_NAME = 'process-checkout';` e usar nas duas pontas se aplicável.

### L3 — Tipo do segundo parâmetro de `enqueue`/handler depende de `Job<CheckoutJob>` sem validação de `job.data`
- **Local:** linhas 62-63
- **Descrição:** `job.data` é confiado como `CheckoutJob` sem qualquer validação de runtime. Dados na fila são serializados em JSON no Redis; um job corrompido/legado com shape diferente passaria como `any` efetivo para `processor.process`. A asserção de tipo é estática, não garante o shape em runtime.
- **Impacto:** Baixo no fluxo normal (o produtor é interno), mas um job malformado quebraria o worker sem mensagem clara.
- **Correção sugerida:** Validação defensiva mínima de `job.data.orderId`/`correlationId` antes de processar, ou um type guard.

### L4 — `depth()` usa `??` para defaults mas `getJobCounts` já retorna números
- **Local:** linhas 89-90
- **Descrição:** `getJobCounts` retorna sempre as chaves solicitadas como `number`; o `?? 0` é defensivo mas redundante. Não é bug — apenas ruído. Mais relevante: `depth` não inclui `prioritized`/`paused`, o que pode subestimar a profundidade real dependendo do uso (hoje não há prioridade/pausa, então ok).
- **Impacto:** Cosmético; possível leve subestimação da métrica `queue_depth` se estados adicionais forem usados no futuro.
- **Correção sugerida:** Manter como está, ou documentar que a profundidade cobre apenas `waiting+active+delayed`.

---

## Pontos positivos

- **Não engole a promise de compensação (linhas 72-79):** o `.catch` no `onExhausted` loga com stack e mensagem clara em PT-BR, alertando para o cenário crítico de overselling (estoque preso). Este é o ponto mais importante do arquivo e está bem tratado.
- **Conexão self-managed via URL (linhas 12-22, 31-32):** decisão arquitetural correta e bem comentada — evita conflito de versões de ioredis ao não reutilizar a instância externa.
- **`maxRetriesPerRequest: null` (linha 20):** corretamente setado, requisito do BullMQ para a conexão bloqueante do worker.
- **DLQ lógica via `removeOnFail: false` (linha 55):** abordagem pragmática e bem comentada para inspeção de falhos.
- **Aderência hexagonal:** implementa `QueuePort` sem vazar BullMQ para o domínio; o domínio só conhece `CheckoutJob`/`QueueProcessor`. Infra fica corretamente isolada.
- **`OnModuleDestroy` (linhas 84-86):** lifecycle NestJS idiomático para shutdown gracioso.
- **Comentários de intenção (linhas 24-33, 70-73):** explicam o "porquê" (semântica de `attemptsMade`, razão da conexão própria), facilitando manutenção.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto no caminho principal e trata bem o risco crítico de compensação. Não há bugs de corrupção de estoque nem race conditions de atomicidade no código deste adapter (a atomicidade fica no `StockPort`/`CheckoutWorker`). Recomenda-se endereçar os dois achados HIGH antes de produção: **(H1)** guard de `register` contra workers duplicados e **(H2)** handlers de evento `'error'` para evitar crash do processo em queda de Redis. Os MEDIUM (retenção de DLQ, close resiliente, validação de URL/TLS) são importantes para robustez operacional mas não bloqueiam o caminho feliz.
