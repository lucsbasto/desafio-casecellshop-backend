# Code Review — src/application/reconcile.scheduler.ts

## Resumo

`ReconcileScheduler` é um wrapper fino e bem escrito que dispara `ReconcileUseCase.execute()` a cada 15s via `@Interval`, com guarda de ambiente de teste e `try/catch` que loga falhas sem derrubar o timer. O código é correto no caminho feliz e adere bem à arquitetura hexagonal. O único risco real de produção é a **ausência de guarda de re-entrância/overlap**: se uma execução demorar mais que 15s (varredura grande, Redis/ERP lento), o `@Interval` dispara execuções concorrentes sobre o mesmo conjunto de PENDING órfãos. Os demais pontos são MEDIUM/LOW (observabilidade, perda de stack trace, falta de teste).

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## HIGH

### HIGH-1 — Sem guarda de re-entrância: `@Interval` permite execuções concorrentes sobrepostas
- **Local:** linha 20–28 (`@Interval(15000)` + `async tick()`).
- **Descrição:** O `@Interval(15000)` do `@nestjs/schedule` agenda o callback por tempo decorrido, **não** "15s após terminar a execução anterior". Como `tick()` é `async` e o scheduler não aguarda a Promise, se `execute()` levar mais de 15s (varredura de muitos PENDING órfãos, latência de Redis na fila/`queue.depth()`, ou `stock.release` lento), o próximo `tick()` dispara enquanto o anterior ainda roda. Resultado: duas (ou mais) reconciliações concorrentes operando sobre **o mesmo conjunto** de candidatos retornados por `findPendingOlderThan`.
- **Impacto:** Em produção isso causa trabalho duplicado e potenciais efeitos colaterais danosos no `ReconcileUseCase`:
  - **Re-enqueue duplicado:** o mesmo `orderId` é enfileirado por duas execuções (`reconcile-${order.id}` é determinístico, mas a fila não necessariamente deduplica). A idempotência do worker mitiga, mas há desperdício e ruído.
  - **Compensação de estoque dupla:** o caminho `maxAgeCutoff` faz `transition(...FAILED)` + `stock.release(...)`. Se duas execuções pegarem o mesmo PENDING antes de qualquer uma persistir o `FAILED`, ambas chamam `stock.release` para os mesmos itens → **liberação de estoque em dobro** (oversell), a menos que `OrderRepositoryPort.save` + `findPendingOlderThan` garantam exclusão atômica (não garantido pela porta in-memory). Esse é o risco mais sério, alinhado ao domínio estoque/idempotência do projeto.
- **Correção sugerida:** Adicionar um flag de execução em andamento (in-flight guard) para descartar ticks sobrepostos. É a forma idiomática e barata:

```ts
@Injectable()
export class ReconcileScheduler {
  private readonly logger = new Logger(ReconcileScheduler.name);
  private running = false;

  constructor(/* ... */) {}

  @Interval(15000)
  async tick(): Promise<void> {
    if (this.config.env === 'test') return;
    if (this.running) {
      this.logger.warn('Reconciliação anterior ainda em andamento; tick ignorado');
      return;
    }
    this.running = true;
    try {
      await this.reconcile.execute();
    } catch (err) {
      this.logger.error('Reconciliação periódica falhou', (err as Error).stack);
    } finally {
      this.running = false;
    }
  }
}
```

Em ambiente multi-instância (várias réplicas do serviço), o guard de processo único **não** é suficiente — nesse caso a atomicidade tem de viver no `ReconcileUseCase`/repositório (lock distribuído via Redis ou `UPDATE ... WHERE status=PENDING` atômico que "reivindica" a order antes de compensar). Vale registrar essa limitação onde a guarda for adicionada.

---

## MEDIUM

### MEDIUM-1 — `catch` descarta o `ReconcileReport` e não emite métrica de falha do scheduler
- **Local:** linha 23–27.
- **Descrição:** O `execute()` retorna `ReconcileReport { requeued, failed, scanned }`, mas o scheduler ignora completamente o retorno. Além disso, falhas da reconciliação periódica só produzem um log; não há contador/métrica Prometheus para "reconciliação periódica falhou", apesar do projeto ter `MetricsService` e foco em observabilidade (OpenTelemetry/Prometheus). Operacionalmente é impossível alertar sobre um scheduler que está falhando silenciosamente a cada 15s sem fazer scraping de logs.
- **Impacto:** Perda de sinal de saúde de um componente de resiliência crítico (anti ghost-order). Um Redis intermitente ou bug no use-case pode degradar a reconciliação por horas sem disparar alerta.
- **Correção sugerida:** Incrementar um contador de erro do scheduler no `catch` (ex.: `this.metrics.reconcileErrors.inc()`), e opcionalmente logar o `ReconcileReport` em debug quando `requeued || failed`. Como o `MetricsService` já é injetável, basta injetá-lo aqui ou expor um counter dedicado.

### MEDIUM-2 — Perda de stack trace no log de erro
- **Local:** linha 26 — `this.logger.error(\`...: ${(err as Error).message}\`)`.
- **Descrição:** Loga apenas `.message`, descartando o stack trace. O `Logger.error` do Nest aceita um segundo argumento `trace` justamente para isso. Para erros de reconciliação (que tocam fila, estoque e repositório), o stack é essencial para diagnóstico.
- **Impacto:** Diagnóstico de produção fica cego à origem real do erro; um `TypeError` profundo no use-case aparece como uma linha de mensagem sem contexto.
- **Correção sugerida:** `this.logger.error('Reconciliação periódica falhou', (err as Error).stack);` (ou passar o objeto de erro completo conforme o transporte de log configurado).

---

## LOW

### LOW-1 — Intervalo hard-coded (`15000`) não configurável e divergente do `reconcile.ageMs` default
- **Local:** linha 20 — `@Interval(15000)`.
- **Descrição:** O período de 15s é literal no decorator, enquanto todos os outros tempos de reconciliação (`ageMs=10000`, `maxAgeMs=60000`) vêm do `AppConfig` via env. Decorators são avaliados em tempo de definição de classe, então não dá para ler `this.config` diretamente; mas o valor fixo cria acoplamento e impede tuning por ambiente. Observe ainda que 15s de intervalo > 10s de `ageMs`: um órfão pode esperar até ~25s para ser reenfileirado no pior caso — aceitável, mas é uma relação implícita não documentada.
- **Impacto:** Baixo. Tuning operacional exige redeploy; relação intervalo/ageMs não é óbvia.
- **Correção sugerida:** Documentar a escolha com comentário, ou migrar para `SchedulerRegistry` + `addInterval()` em `onModuleInit` lendo `this.config.reconcile.intervalMs`, o que torna o período configurável por env.

### LOW-2 — Guarda `env === 'test'` espalhada e dependente de string mágica
- **Local:** linha 22 — `if (this.config.env === 'test') return;`.
- **Descrição:** O scheduler decide seu próprio liga/desliga comparando a string `'test'`. O mesmo padrão provavelmente existe em outros schedulers/workers. É frágil (typo em `NODE_ENV`, valores como `'testing'`/`'ci'` não cobertos) e mistura política de ambiente com lógica do componente.
- **Impacto:** Baixo. Funciona hoje, mas é um ponto de divergência silenciosa se a convenção de `NODE_ENV` mudar.
- **Correção sugerida:** Expor um booleano semântico no config (ex.: `config.reconcile.enabled` ou `config.schedulersEnabled`) derivado de `env`, e checá-lo aqui. Centraliza a política e elimina a string mágica.

### LOW-3 — Ausência de teste unitário para o scheduler
- **Local:** arquivo inteiro (não há `reconcile.scheduler.spec.ts`).
- **Descrição:** Não existe teste cobrindo os comportamentos relevantes: (a) `env==='test'` → `execute()` não é chamado; (b) caminho feliz chama `execute()` uma vez; (c) exceção em `execute()` é capturada e logada sem propagar (timer não morre). São comportamentos baratos de testar com um mock do `ReconcileUseCase`.
- **Impacto:** Baixo, mas a guarda de re-entrância (HIGH-1) e a guarda de ambiente são exatamente o tipo de lógica que regride silenciosamente sem teste.
- **Correção sugerida:** Adicionar spec com mock de `ReconcileUseCase` e `AppConfig`, asserindo os três comportamentos acima (e, após corrigir HIGH-1, que um tick sobreposto é ignorado enquanto `running===true`).

---

## Pontos positivos

- **Responsabilidade única e bem delimitada:** o scheduler é um adaptador de driver (tempo) que apenas dispara o use-case; toda a lógica de domínio vive no `ReconcileUseCase`. Aderência exemplar à arquitetura hexagonal — nenhum vazamento de infra ou domínio aqui.
- **`try/catch` correto no callback agendado:** evita que uma exceção não tratada derrube/silencie o timer do `@nestjs/schedule`. Decisão certa para tarefas periódicas.
- **DI idiomática do Nest:** `@Injectable`, injeção do use-case e do `APP_CONFIG` via token/symbol, `Logger` com nome da classe.
- **Comentário de cabeçalho útil:** documenta a desativação em teste e aponta o endpoint `POST /admin/reconcile` como alternativa determinística — boa pista para quem mantém.
- **`(err as Error)` em vez de `any`:** assertion de tipo contida e razoável no `catch`.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é limpo, idiomático e arquiteturalmente correto. Não há bugs no caminho feliz nem problemas de segurança. A ressalva relevante é **HIGH-1 (re-entrância/overlap)**: dado o domínio de estoque/idempotência, execuções concorrentes de reconciliação podem causar compensação de estoque duplicada se a atomicidade não estiver garantida a jusante — a guarda in-flight deve ser adicionada antes de produção (com nota sobre o cenário multi-instância). Os itens MEDIUM (métrica de falha, stack trace) e LOW (intervalo configurável, env-guard, teste) são melhorias de robustez/observabilidade recomendadas, não bloqueantes.
