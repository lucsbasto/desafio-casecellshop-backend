# Code Review — src/application/use-cases/checkout-flow.spec.ts

## Resumo

Suíte de teste de integração leve ("harness" in-memory) que exercita o fluxo
assíncrono de checkout ponta a ponta: happy path, idempotência, concorrência de
estoque e resiliência (ERP falhando + compensação). É um arquivo sólido,
determinístico (sem sleeps, com `drain()` e `random` injetável) e com boa
cobertura comportamental dos cenários críticos do desafio. Os achados são
majoritariamente de robustez/manutenibilidade — nenhum bug que invalide os
testes.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 2         |
| LOW        | 5         |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

### M1. Acoplamento frágil à semântica de `random` no `FakeErpClient`

- **Local:** linha 47 — `random: () => (opts.erpFailRate >= 1 ? 0 : 0.99)`
- **Descrição:** O harness reproduz manualmente a regra de decisão interna do
  `FakeErpClient` (`randomFail() < failRate`). Para `failRate=1` retorna `0`
  (`0 < 1` → falha); para `failRate=0` retorna `0.99` (`0.99 < 0` → sucesso).
  Funciona, mas só para os dois extremos usados hoje (0 e 1). Qualquer
  `erpFailRate` intermediário (ex.: 0.5) produziria comportamento não-óbvio,
  porque o mesmo draw alimenta latência **e** falha (`shared` em
  `fake-erp.client.ts` linhas 32-34). O teste depende de um detalhe de
  implementação do cliente, não de um contrato.
- **Impacto:** Se a lógica de `randomFail` mudar (ex.: `<=` em vez de `<`, ou
  draws dedicados), os testes podem passar/falhar silenciosamente sem refletir
  o ERP real. Reduz o valor do teste como rede de segurança.
- **Correção sugerida:** Injetar draws dedicados e nomeados, deixando a intenção
  explícita e desacoplada da fórmula:

  ```ts
  const erp = new FakeErpClient({
    failRate: opts.erpFailRate,
    minLatencyMs: 0,
    maxLatencyMs: 0,
    randomFail: () => (opts.erpFailRate >= 1 ? 0 : 1), // 1 nunca < failRate<1 => sucesso
    randomLatency: () => 0,
  });
  ```

  Alternativamente, para o caso "sempre falha", usar um stub de `ErpPort` que
  rejeita direto — isolando o teste da matemática do fake.

### M2. `worker.onModuleInit()` chamado sem garantir cleanup / `close()` da fila

- **Local:** linhas 60-61 e retorno (linha 64); ausência de `afterEach`
- **Descrição:** Cada `buildHarness` cria uma `InMemoryQueueAdapter` e chama
  `worker.onModuleInit()` (registra o processor). Os testes `happy path` e
  `resiliência` chamam `drain()`, mas `idempotência` e `concorrência` **não**
  drenam a fila. Como `enqueue` dispara `run(job)` de forma assíncrona
  (fire-and-forget, `in-memory-queue.adapter.ts` linhas 38-49), ao término
  desses testes ainda há jobs em voo processando contra `orders`/`stock`/`erp`
  daquele harness. Não há `queue.close()`/`drain()` em `afterEach`.
- **Impacto:** Trabalho assíncrono pendente após o fim do teste. Aqui é benigno
  porque cada harness é isolado (sem estado global compartilhado) e o
  `.catch(() => undefined)` da fila evita unhandled rejection. Mas é uma fonte
  clássica de flakiness/"open handles" do Jest e de logs vazando entre testes;
  fragiliza a suíte conforme ela cresce.
- **Correção sugerida:** Expor a `worker`/`queue` e drenar/fechar no teardown:

  ```ts
  let harnesses: { queue: InMemoryQueueAdapter }[] = [];
  // em buildHarness: harnesses.push({ queue });
  afterEach(async () => {
    await Promise.all(harnesses.map((h) => h.queue.close()));
    harnesses = [];
  });
  ```

---

## LOW

### L1. Teste de concorrência não falha explicitamente em erro inesperado

- **Local:** linhas 113, 117-118
- **Descrição:** O `.catch` mapeia erros não-`InsufficientStockError` para
  `'err'`, mas as asserções só contam `'ok'` (2) e `'no-stock'` (3). Um `'err'`
  seria detectado apenas indiretamente (quebraria uma das duas contagens), sem
  mensagem clara.
- **Impacto:** Diagnóstico ruim se um erro inesperado surgir (ex.: produto não
  encontrado). A causa-raiz ficaria escondida atrás de um "expected length 2,
  received 1".
- **Correção sugerida:** Adicionar `expect(outcomes.filter((o) => o === 'err')).toHaveLength(0);`
  para tornar a falha autoexplicativa.

### L2. `metrics` é desestruturado mas nunca usado/asserido

- **Local:** linha 64 (`return { checkout, queue, getStatus, stock, metrics }`)
- **Descrição:** O harness expõe `metrics`, mas nenhum teste verifica contadores
  (`oversellPrevented`, `stockReservation`, `workerJobs{result}`,
  `checkoutRequests{outcome}`). A observabilidade é um requisito explícito do
  projeto (OBS-2 / overselling evitado) e está sem cobertura.
- **Impacto:** Regressões na instrumentação (ex.: parar de incrementar
  `oversell_prevented_total`) passariam despercebidas. Além disso, expor um
  valor não usado é ruído.
- **Correção sugerida:** Ou remover `metrics` do retorno, ou — preferível —
  adicionar uma asserção no teste de concorrência, p.ex. validar que
  `oversellPrevented` foi incrementado 3 vezes via `metrics.registry.getSingleMetric(...)`.

### L3. Ausência de cenário com `idempotencyKey` ausente (caminho `randomUUID`/warn)

- **Local:** cobertura geral (todos os testes passam `idempotencyKey`)
- **Descrição:** O use-case tem um ramo relevante quando `idempotencyKey` é
  `undefined` (gera UUID + `logger.warn`, `checkout.usecase.ts` linhas 77-82),
  e também o ramo `DuplicateRequestError` (chave reivindicada sem pedido
  persistido, linha 96). Nenhum dos dois é exercitado aqui.
- **Impacto:** Lacuna comportamental em caminhos de borda de idempotência.
- **Correção sugerida:** Adicionar um teste sem `idempotencyKey` (verificando que
  cria pedido normalmente) e, se possível, um para `DuplicateRequestError`.

### L4. Comentários em PT misturados com nomes/descrições em EN; `// registra na fila`

- **Local:** linha 61 (`// registra na fila`), linhas 36/42 (comentários em EN)
- **Descrição:** Mistura de idiomas nos comentários do mesmo arquivo (EN nas
  linhas 36 e 42, PT na 61). Puramente cosmético.
- **Impacto:** Consistência/leitura. Nenhum efeito funcional.
- **Correção sugerida:** Padronizar o idioma dos comentários do arquivo.

### L5. `SEED` compartilhado entre testes depende de cópia defensiva do repo/stock

- **Local:** linha 67 (`const SEED: Product[] = [...]`)
- **Descrição:** O mesmo array `SEED` (e os objetos `Product` dentro dele) é
  reutilizado por todos os testes. Funciona porque `InMemoryProductRepository`
  faz `{ ...p }` (cópia, linha 24 do repo) e o estoque é mantido fora do
  `Product` no `InMemoryStockAdapter`. É uma garantia implícita: se algum
  adapter passar a mutar o `Product` recebido, haveria vazamento de estado
  entre testes.
- **Impacto:** Risco latente de acoplamento entre testes via objeto mutável
  compartilhado.
- **Correção sugerida:** Transformar `SEED` numa factory (`const seed = () => [{ ... }]`)
  ou congelar (`Object.freeze`) para tornar a imutabilidade explícita.

---

## Pontos positivos

- **Determinismo real:** sem `sleep`/timers arbitrários; usa `queue.drain()` e
  `random` injetável (`min/maxLatencyMs = 0`, `backoffMs = 0`) — testes rápidos
  e estáveis.
- **Cobertura dos cenários-chave do desafio:** happy path, idempotência
  (replay + reserva única), prevenção de overselling sob concorrência
  (5 → 2 aceitos / 3 negados) e resiliência (FAILED após retries + compensação
  de estoque). Cada `it` valida estado terminal **e** efeito colateral no
  estoque.
- **Harness bem fatorado:** `baseConfig` com override parcial tipado
  (`Partial<AppConfig['worker']>`) e `buildHarness` parametrizado mantêm os
  testes legíveis e sem duplicação.
- **Asserções comportamentais, não de implementação:** verifica `status`,
  `replay`, contagens de desfecho e saldo de estoque — não detalhes internos.
- **Fidelidade arquitetural:** monta o grafo de dependências manualmente
  respeitando as portas (stock/idempotency/queue/repos/erp), sem vazar infra no
  domínio; o comentário da linha 36 deixa claro que substitui o `StockSeeder` do
  módulo.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está funcionalmente correto e cobre bem os comportamentos críticos.
As ressalvas são de robustez e manutenibilidade da própria suíte: desacoplar a
decisão de falha do ERP (M1) e adicionar teardown/`drain` para evitar trabalho
assíncrono pendente entre testes (M2). Os achados LOW (asserção explícita de
erro, cobertura de métricas e dos ramos de idempotência sem chave) elevam o
valor da suíte como rede de segurança, mas não bloqueiam.
