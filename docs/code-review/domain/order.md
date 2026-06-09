# Code Review — src/domain/order.ts

Arquivo de domínio puro: define o agregado `Order`, a máquina de estados (`OrderStatus`),
e funções puras (`isTerminal`, `canTransition`, `transition`). Sem dependências de
infraestrutura — aderência hexagonal exemplar. O código é sólido e correto nos casos
principais; os achados abaixo são endurecimentos de borda e questões de imutabilidade,
nenhum bloqueante.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 2         |
| LOW        | 4         |

---

## MEDIUM

### M1 — Imutabilidade rasa: `items` (e entradas antigas de `history`) compartilhadas por referência
- **Local:** linhas 65-70 (`transition`)
- **Descrição:** O JSDoc afirma "Pure function: returns a new Order, does not mutate
  the original". O spread `{ ...order, ... }` é raso: o novo pedido reaproveita o **mesmo
  array `items`** por referência e as mesmas instâncias de `OrderTransition` antigas. Um
  consumidor que faça `next.items.push(...)` ou `next.items[0].quantity = 9` mutará também
  o `order` original, violando a garantia de pureza anunciada.
- **Impacto:** Vazamento de mutação entre estados do agregado. Em fluxo de retry/worker
  (`checkout.worker.ts` reusa `processing` para gerar `confirmed`), um bug de mutação de
  `items` em qualquer camada se propagaria silenciosamente para objetos já persistidos em
  memória (`in-memory-order.repo`), corrompendo histórico de estoque/compensação. O risco é
  hoje latente (ninguém muta `items`), mas a promessa do contrato não se sustenta.
- **Correção sugerida:** Ou congelar/clonar profundamente, ou suavizar o JSDoc para
  "shallow copy". Recomendo congelar para tornar o contrato executável:
  ```ts
  const next: Order = {
    ...order,
    status: to,
    updatedAt: at,
    history: [...order.history, Object.freeze({ status: to, at, reason })],
  };
  return Object.freeze(next);
  ```
  Para garantia total, tipar com `ReadonlyArray<OrderItem>` / `readonly` nos campos da
  interface `Order`, fazendo o compilador proibir mutação sem custo de runtime.

### M2 — `transition` ignora o relógio (`at`) e não valida a ordem temporal nem o formato ISO
- **Local:** linhas 60-70; campo `at: string` (linha 21)
- **Descrição:** `at` é um `string` "ISO timestamp" por convenção apenas — não há validação
  de formato nem garantia de monotonicidade. `transition` aceita qualquer string e a grava
  em `updatedAt` e no `history`. Um chamador pode passar `''`, `'agora'`, ou um timestamp
  **anterior** ao `updatedAt` atual, produzindo um histórico fora de ordem cronológica.
- **Impacto:** Em reconciliação/observabilidade (o domínio existe justamente para alimentar
  isso), `updatedAt` regredindo ou um `at` inválido quebra ordenação, métricas de latência
  por estado e auditoria. Como é o ponto único de escrita de transições, é o lugar natural
  para impor o invariante.
- **Correção sugerida:** Validar e, opcionalmente, garantir monotonicidade:
  ```ts
  if (Number.isNaN(Date.parse(at))) {
    throw new InvalidOrderTransitionError(order.status, to); // ou erro dedicado de timestamp
  }
  if (at < order.updatedAt) {
    // log/erro: transição com carimbo retroativo
  }
  ```
  Alternativa hexagonalmente mais limpa: receber um `Clock`/`Date` em vez de string,
  centralizando a fonte de tempo (hoje cada chamador faz `new Date().toISOString()`,
  duplicando a lógica em 4+ lugares).

---

## LOW

### L1 — Retorno idempotente descarta `at`/`reason` silenciosamente
- **Local:** linha 61 (`if (order.status === to) return order;`)
- **Descrição:** Quando já se está no estado destino, a função retorna o pedido **inalterado**,
  ignorando o `reason` e o `at` fornecidos. É a semântica idempotente desejada (e testada em
  `order.spec.ts:33`), mas significa que uma re-tentativa com um motivo diferente não é
  registrada no histórico nem atualiza `updatedAt`.
- **Impacto:** Baixo — comportamento intencional e documentado. Apenas observabilidade: uma
  segunda confirmação com motivo distinto some sem rastro. Aceitável para idempotência.
- **Correção sugerida:** Nenhuma ação obrigatória. Se rastrear re-tentativas no destino for
  desejável, anexar uma entrada de histórico "no-op" — mas isso conflita com o teste atual
  (`expect(same).toBe(o)`). Manter como está e apenas documentar a decisão.

### L2 — Campo `attempts` no agregado não tem invariante imposto pelo domínio
- **Local:** linhas 34-35 (`attempts`); o domínio nunca o lê/escreve
- **Descrição:** `attempts` faz parte do agregado `Order`, mas `transition` não o incrementa
  nem valida. O worker (`checkout.worker.ts:72`) faz `{ ...order, attempts: attempt }`
  manualmente antes de transicionar. A regra de double-processing (`attempt === order.attempts`)
  vive inteiramente na aplicação, não no domínio.
- **Impacto:** Baixo, mas é um invariante de concorrência crítico (evitar fatura ERP dupla)
  morando fora do domínio, onde o spread manual pode esquecer de propagar `attempts` em algum
  caminho futuro. O domínio "puro" não protege contra `attempts` regredindo.
- **Correção sugerida:** Considerar expor um helper de domínio (ex.: `beginAttempt(order, n)`)
  que valide `n >= order.attempts` e produza o novo agregado, em vez de espalhar a montagem do
  estado pela camada de aplicação. Não urgente.

### L3 — `ALLOWED` e `isTerminal` codificam a mesma informação em dois lugares
- **Local:** linhas 39-46 (`ALLOWED`, terminais têm `[]`) vs. linhas 48-50 (`isTerminal`)
- **Descrição:** "Terminal" é definido duas vezes: implicitamente em `ALLOWED` (array vazio) e
  explicitamente em `isTerminal`. Adicionar um futuro estado terminal exige atualizar ambos;
  esquecer um gera inconsistência (ex.: `isTerminal` retornando `false` para um estado sem
  transições de saída).
- **Impacto:** Baixo — risco de manutenção. Hoje os dois estão coerentes.
- **Correção sugerida:** Derivar um do outro:
  ```ts
  export function isTerminal(status: OrderStatus): boolean {
    return ALLOWED[status].length === 0;
  }
  ```
  Assim `ALLOWED` vira a única fonte da verdade da máquina de estados.

### L4 — `history` cresce sem limite (sem cota nem compactação)
- **Local:** linha 69 (`history: [...order.history, ...]`)
- **Descrição:** Cada transição anexa ao `history`. Para este fluxo (máx. ~3-4 transições por
  pedido: PENDING → PROCESSING → CONFIRMED/FAILED) é irrelevante. Vale registrar que se
  reconciliação/retries puderem gerar muitas transições, o array — e o payload persistido —
  crescem monotonicamente.
- **Impacto:** Desprezível no domínio atual. Apenas nota de escala.
- **Correção sugerida:** Nenhuma agora. Se o número de transições por pedido puder explodir,
  considerar mover o histórico para um log append-only externo em vez de carregá-lo no agregado.

---

## Pontos positivos

- **Aderência hexagonal exemplar:** zero dependência de infra; só importa `errors` do próprio
  domínio. Funções puras, sem I/O, sem NestJS — testável trivialmente.
- **Máquina de estados explícita e bem comentada:** o comentário nas linhas 41-42 documenta a
  decisão deliberada de PROCESSING não voltar a PENDING (evita reprocessamento duplo via
  reconciliação) — exatamente o tipo de invariante de concorrência que merece estar no domínio.
- **`canTransition` defensivo:** `ALLOWED[from]?.includes(to) ?? false` protege em runtime
  contra um `from` que não seja um membro válido do enum (ex.: status vindo de JSON/persistência
  corrompida), apesar do tipo estático garantir cobertura total do `Record`.
- **Idempotência correta:** o early-return por status igual cobre entregas duplicadas de
  mensagem, alinhado ao guard do worker.
- **Erros de domínio tipados:** `InvalidOrderTransitionError` carrega `from`/`to`, traduzível
  para HTTP 409 na borda sem acoplar o domínio ao protocolo.
- **Cobertura de testes adequada** para um arquivo deste porte: happy path, bloqueio de
  terminal, idempotência, imutabilidade do original e `isTerminal`.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto, idiomático e fiel à arquitetura hexagonal. Nenhum achado é bloqueante.
Recomendo endereçar **M1** (alinhar a garantia de imutabilidade do JSDoc com a realidade —
preferencialmente via `readonly`/`Object.freeze`) e **M2** (validar/centralizar o `at`) antes
de evoluir o domínio, pois ambos tocam invariantes que a camada de aplicação hoje assume
implicitamente. Os LOW são melhorias de manutenção sem urgência.
