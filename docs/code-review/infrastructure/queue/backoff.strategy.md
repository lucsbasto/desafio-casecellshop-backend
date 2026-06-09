# Code Review — src/infrastructure/queue/backoff.strategy.ts

## Resumo

Arquivo pequeno, coeso e idiomático que extrai o cálculo de backoff exponencial para uma `Strategy` compartilhada entre a fila in-memory e o adapter BullMQ. A lógica central está **correta** e mantém paridade comportamental com o backoff exponencial nativo do BullMQ. Os achados são de robustez/validação de entrada e ausência de testes dedicados — nenhum é bloqueante.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 2          |
| LOW        | 4          |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

### M1 — Ausência de testes unitários dedicados para a estratégia de backoff

- **Local:** arquivo inteiro (`backoff.strategy.ts`); não existe `backoff.strategy.spec.ts` no repositório.
- **Descrição:** `ExponentialBackoff` encapsula a regra mais sensível do retry (a progressão de delays e o teto). Não há nenhum teste que fixe o contrato: `nextDelay(1) === 0`, a progressão `base, base*factor, base*factor^2, ...`, o `Math.min` contra `maxMs`, e os casos de borda (`baseMs <= 0`, `attempt <= 1`). Hoje o comportamento só é exercitado indiretamente por `checkout-flow.spec.ts`, e sempre com `backoffMs: 0` — ou seja, o caminho de cálculo real (`delay = base * factor ** (attempt-2)`) **nunca é executado em teste**.
- **Impacto:** uma regressão na fórmula (ex.: trocar `attempt-2` por `attempt-1`, quebrar a paridade com o BullMQ, ou remover o cap) passaria despercebida. É exatamente o tipo de lógica numérica onde um off-by-one é fácil de introduzir e difícil de notar em produção.
- **Correção sugerida:** adicionar `backoff.strategy.spec.ts` cobrindo o contrato e as bordas:

```ts
describe('ExponentialBackoff', () => {
  it('não espera antes da 1ª tentativa', () => {
    expect(new ExponentialBackoff(500).nextDelay(1)).toBe(0);
    expect(new ExponentialBackoff(500).nextDelay(0)).toBe(0);
  });

  it('progride exponencialmente: base, base*factor, base*factor^2', () => {
    const b = new ExponentialBackoff(500, 2, 1_000_000);
    expect(b.nextDelay(2)).toBe(500);
    expect(b.nextDelay(3)).toBe(1000);
    expect(b.nextDelay(4)).toBe(2000);
  });

  it('respeita o teto maxMs', () => {
    expect(new ExponentialBackoff(500, 2, 1500).nextDelay(5)).toBe(1500);
  });

  it('baseMs <= 0 desativa o backoff', () => {
    expect(new ExponentialBackoff(0).nextDelay(5)).toBe(0);
  });
});
```

### M2 — Parâmetros não são validados/saneados; entradas inválidas produzem delays patológicos

- **Local:** construtor (`:16-20`) e `nextDelay` (`:22-26`).
- **Descrição:** a classe confia plenamente em `baseMs`, `factor`, `maxMs` e `attempt`. Os valores chegam de `InMemoryQueueOptions`, que por sua vez vêm de `app-config.ts` via `num()`. O helper `num()` (`app-config.ts:7-11`) só garante `Number.isFinite`, mas **não impede negativos nem zero** (ex.: `WORKER_BACKOFF_MS=-100` ou `factor=0.5`). Consequências:
  - `factor < 1` torna o "backoff" decrescente (anti-padrão silencioso).
  - `factor` negativo com expoente fracionário não é o caso aqui (expoente é inteiro), mas `factor` negativo gera delays oscilando de sinal; se `delay` ficar negativo, `Math.min(negativo, maxMs)` retorna o negativo, e só não quebra porque `sleep()` no consumidor trata `ms <= 0` (`in-memory-queue.adapter.ts:72`). Essa segurança mora no **consumidor**, não na estratégia — frágil para outros consumidores.
  - `maxMs` negativo faz `Math.min` devolver `maxMs` negativo para qualquer delay positivo, anulando o backoff sem aviso.
  - `attempt` não-inteiro (ex.: `2.5`) produz expoente fracionário e delay arbitrário; não acontece com os chamadores atuais, mas o contrato não defende.
- **Impacto:** configuração incorreta degrada silenciosamente a política de retry (sem backoff, ou backoff invertido) em vez de falhar cedo. Em e-commerce com ERP instável, isso pode virar tempestade de retries sem espaçamento (efeito thundering-herd sobre o ERP).
- **Correção sugerida:** sanear no construtor e garantir piso de 0 na saída, deixando a invariante na própria estratégia:

```ts
constructor(
  private readonly baseMs: number,
  factor = 2,
  maxMs = 30_000,
) {
  this.factor = factor >= 1 ? factor : 1;
  this.maxMs = Math.max(0, maxMs);
}

nextDelay(attempt: number): number {
  const n = Math.floor(attempt);
  if (n <= 1 || this.baseMs <= 0) return 0;
  const delay = this.baseMs * this.factor ** (n - 2);
  return Math.max(0, Math.min(delay, this.maxMs));
}
```

(Alternativamente, validar no `loadConfig`/Joi e documentar a pré-condição — mas defender na estratégia é mais barato e local.)

---

## LOW

### L1 — Backoff sem jitter pode causar sincronização de retries (thundering herd)

- **Local:** `nextDelay` (`:22-26`).
- **Descrição:** o delay é puramente determinístico. Quando muitos jobs falham ao mesmo tempo (ex.: ERP cai e volta), todos reespaçam exatamente nos mesmos instantes (`base`, `base*2`, ...), rebatendo no serviço em rajadas sincronizadas.
- **Impacto:** menor neste contexto in-memory de processo único, mas é uma boa prática reconhecida (full/equal jitter) em filas de retry. O BullMQ nativo também não aplica jitter por padrão, então a paridade se mantém — por isso LOW.
- **Correção sugerida:** opcionalmente oferecer uma variante com jitter (`delay * (0.5 + Math.random() * 0.5)`), injetando a fonte de aleatoriedade para manter testabilidade determinística.

### L2 — Semântica 1-based de `attempt` com offset de `+1` no chamador é sutil e propensa a erro

- **Local:** contrato `nextDelay(attempt)` (`:10-11`, `:22`) vs. chamada `nextDelay(attempt + 1)` em `in-memory-queue.adapter.ts:65`.
- **Descrição:** o método espera "o número da tentativa que está prestes a ocorrer" (1-based, com `attempt-2` no expoente), mas o consumidor passa `attempt + 1` (a próxima tentativa) após uma falha. Há, portanto, dois ajustes de índice (`+1` no chamador, `-2` no expoente) que precisam casar mentalmente. Está correto hoje, mas é uma área quente para off-by-one em futuras edições.
- **Impacto:** baixo — funciona e tem comentário explicativo no topo do arquivo (`:5-7`). Mas a carga cognitiva é alta para um cálculo de uma linha.
- **Correção sugerida:** considerar redefinir o contrato em termos de "retries já realizados" (0-based: `nextDelay(retries)` com `base * factor^retries`), eliminando o `-2` e tornando a chamada `nextDelay(attempt - 1)` mais legível; ou ao menos reforçar o ponto com os testes de M1 travando os valores exatos.

### L3 — `maxMs` default duplicado em dois lugares (DRY)

- **Local:** `backoff.strategy.ts:19` (`maxMs = 30_000`) e `in-memory-queue.adapter.ts:30` (`opts.maxBackoffMs ?? 30_000`).
- **Descrição:** o teto padrão de 30s aparece literal em dois arquivos. Se um mudar e o outro não, o comportamento depende de qual caminho instancia a estratégia.
- **Impacto:** baixo (mesmo valor hoje), mas é uma fonte clássica de divergência silenciosa.
- **Correção sugerida:** exportar a constante de um único lugar (ex.: `export const DEFAULT_MAX_BACKOFF_MS = 30_000;` em `backoff.strategy.ts`) e reutilizá-la no adapter, ou simplesmente deixar o default na estratégia e não repeti-lo no adapter (passar `opts.maxBackoffMs` e deixar o `?? 30_000` apenas no construtor da estratégia).

### L4 — Risco teórico de overflow para `attempt` muito alto (sem efeito prático com cap)

- **Local:** `:24` (`this.baseMs * this.factor ** (attempt - 2)`).
- **Descrição:** para `attempt` grande, `factor ** (attempt-2)` cresce até `Infinity`. `Math.min(Infinity, maxMs)` devolve `maxMs` corretamente, então **não há bug** — o cap protege. Vale registrar apenas para deixar explícito que o teto é o que salva o cálculo de números absurdos.
- **Impacto:** nenhum na prática (cap presente e `maxAttempts` limita as iterações). Mantido como nota.
- **Correção sugerida:** nenhuma ação necessária; o teste de M1 com `attempt` alto documenta que o cap segura o overflow.

---

## Pontos positivos

- **Padrão Strategy bem aplicado:** interface mínima (`nextDelay`) e implementação única, eliminando a duplicação da fórmula entre fila in-memory e BullMQ — fonte única de verdade. Comentário no topo justifica o padrão e a semântica do índice.
- **Correção da fórmula e paridade com BullMQ:** `base * factor^(attempt-2)` chamado com `nextDelay(attempt+1)` reproduz exatamente `delay * 2^(attemptsMade-1)` do backoff exponencial nativo do BullMQ (waits: `base, 2·base, 4·base, ...`). A intenção de "mirror" declarada no adapter se sustenta.
- **Edge cases principais tratados:** `attempt <= 1` e `baseMs <= 0` retornam `0` cedo; o cap via `Math.min` evita delays ilimitados.
- **Aderência hexagonal impecável:** classe pura, sem dependência de NestJS, infra, I/O, relógio ou estado. Totalmente determinística e trivial de testar; nenhum vazamento de infra no cálculo.
- **Imutabilidade e tipos:** campos `readonly`, sem `any`, sem asserções de tipo inseguras, sem efeitos colaterais. Função pura ideal.

---

## Veredito

**Aprovado com ressalvas.**

A lógica está correta, idiomática e arquiteturalmente limpa — nada bloqueia o merge. As ressalvas são de robustez e cobertura: (M1) adicionar testes unitários dedicados — a fórmula real hoje não é exercitada em teste; e (M2) sanear/validar parâmetros para que configurações inválidas (negativos, `factor < 1`, `maxMs` negativo) não degradem o backoff silenciosamente, em vez de depender da proteção `ms <= 0` que mora no consumidor. Os achados LOW são melhorias opcionais (jitter, DRY do default, clareza do índice 1-based).
