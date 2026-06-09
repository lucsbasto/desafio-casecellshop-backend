# Code Review — test/http.e2e.spec.ts

## Resumo

Suite de testes E2E de contrato HTTP, executada 100% in-memory (sem Docker), cobrindo catálogo+cache, checkout assíncrono (202/PENDING→CONFIRMED), idempotência, falta de estoque (409), validação (400) e métricas. A suite é sólida, determinística e bem desenhada (uso de `queue.drain()` em vez de `sleep`). Os achados são em sua maioria de robustez/manutenção; não há defeitos críticos de correção. Veredito: **Aprovado com ressalvas**.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 1 |
| MEDIUM     | 3 |
| LOW        | 5 |

---

## HIGH

### H1 — Acoplamento de ordem entre testes via estoque compartilhado (estado global mutável)
- **Local:** linhas 63-80 (`CAPA-001`), 82-98 (`CAPA-005`), 100-107 (`CAPA-004`), e a suite inteira.
- **Descrição:** Os testes compartilham uma única instância da aplicação (`beforeAll`, sem `beforeEach`/reset). O estoque é estado mutável global: cada checkout bem-sucedido decrementa o estoque do `InMemoryStockAdapter`. Hoje funciona porque os SKUs de "sucesso" (`CAPA-001` stock=25, `CAPA-005` stock=50) têm folga e o de "sem estoque" (`CAPA-004` stock=0) é independente. Mas a suite passa a depender implicitamente de: (a) ordem de execução dos testes, (b) quantidades de seed específicas, (c) nenhum teste futuro esgotar esses SKUs. O Jest não garante isolamento aqui — qualquer reordenação, `test.concurrent`, ou novo teste que faça vários checkouts de `CAPA-001` pode quebrar de forma intermitente e difícil de diagnosticar.
- **Impacto:** Fragilidade latente e flakiness potencial. Em uma suite de e-commerce com estoque/idempotência, testes que dependem de estado acumulado são exatamente a classe de bug que mais custa a depurar.
- **Correção sugerida:** Tornar a dependência explícita e o isolamento real. Opções, em ordem de preferência:
  1. Recriar a app (ou re-semear o estoque) num `beforeEach`, garantindo estado limpo por teste. Se o custo de bootstrap for alto, expor um método de reset no `InMemoryStockAdapter` e chamá-lo no `beforeEach`.
  2. No mínimo, documentar e travar a premissa: assertar o estoque/quantidade restante após cada checkout, ou usar SKUs dedicados por teste para que nenhum teste dependa do efeito colateral de outro.

---

## MEDIUM

### M1 — `drain()` não é chamado no teste de "sem estoque", deixando trabalho em voo entre testes
- **Local:** linhas 100-107 (e contraste com 74, 97).
- **Descrição:** O caminho 409 (estoque insuficiente) é rejeitado de forma síncrona na request HTTP, então de fato não enfileira job — ok. Porém o padrão da suite é inconsistente: alguns testes drenam a fila (74, 97) e outros não. Mais relevante: não há um `afterEach(() => queue.drain())` global. Se qualquer teste deixar um job em voo (ex.: o de payload inválido, ou um futuro teste), esse job pode completar durante o próximo teste, mutando estoque/métricas e gerando acoplamento temporal não-determinístico.
- **Impacto:** Vazamento de trabalho assíncrono entre testes; fonte clássica de flakiness e de poluição das métricas observadas em M2.
- **Correção sugerida:** Adicionar `afterEach(async () => { await queue.drain(); });` para garantir que nenhum job atravesse a fronteira entre testes. O `afterAll` já fecha a app, mas isso não protege os testes intermediários.

### M2 — Asserções de métricas frágeis e acopladas à ordem (`/metrics` é cumulativo)
- **Local:** linhas 49-51, 117-122.
- **Descrição:** As métricas Prometheus são cumulativas no processo. O teste de cache (49-51) assume que, no momento em que roda, já houve pelo menos 1 hit (`[1-9]`). Isso só é verdade porque esse teste é o primeiro e faz 2 GETs ele mesmo. O teste de métricas de checkout (117-122) usa `toContain('checkout_requests_total')` — que só verifica a *presença do nome da métrica* (que existe assim que o registry é inicializado), não que um checkout realmente aconteceu. A assertion é quase sempre verdadeira independentemente do comportamento, oferecendo cobertura comportamental fraca.
- **Impacto:** Os testes de métrica podem passar mesmo se a instrumentação estiver quebrada (ex.: `checkout_requests_total` declarado mas nunca incrementado). Falsa sensação de cobertura.
- **Correção sugerida:** Assertar valores/labels específicos com regex que exija contador ≥ 1, como já é feito em 51. Ex.: `expect(metrics.text).toMatch(/checkout_requests_total\{[^}]*\}\s+[1-9]/)` e idem para `worker_jobs_total`. Considere também capturar o valor antes/depois de um checkout e assertar o incremento, em vez de depender do estado acumulado.

### M3 — Configuração de pipe/filter duplicada manualmente diverge da produção (`main.ts`)
- **Local:** linhas 28-31 vs `src/main.ts:18-21`.
- **Descrição:** O `ValidationPipe` e o `DomainExceptionFilter` são reconstruídos à mão no teste, replicando literalmente a config de `main.ts`. Como `bootstrap()` em `main.ts` não é reutilizado, qualquer mudança futura na config de produção (ex.: adicionar `transformOptions`, `disableErrorMessages`, um interceptor de correlação, outro filtro) NÃO será refletida no E2E. O teste pode passar enquanto a produção se comporta diferente — exatamente o que um teste de contrato deveria pegar.
- **Impacto:** Drift entre ambiente testado e ambiente real; reduz o valor do E2E como rede de segurança de contrato.
- **Correção sugerida:** Extrair a configuração compartilhada (pipes + filters + interceptors) para uma função única, ex. `configureApp(app)`, chamada tanto por `main.ts` quanto pelo teste. Assim o E2E exercita a mesma config da produção.

---

## LOW

### L1 — `app.get(QUEUE_PORT)` com cast inseguro para a implementação concreta
- **Local:** linha 34 (`queue = app.get(QUEUE_PORT) as InMemoryQueueAdapter;`).
- **Descrição:** O cast `as InMemoryQueueAdapter` assume que o container resolveu a adapter in-memory. Se a seleção memory/redis depender de env e algo mudar (ex.: `NODE_ENV`/flag de fila), o `app.get` retornaria a `BullMQ` adapter e `queue.drain()` (que não existe na port `QueuePort`) seria `undefined`, causando `TypeError` confuso em runtime em vez de um erro claro. `drain()` não faz parte de `QueuePort` — é específico do adapter de teste.
- **Impacto:** Mensagem de falha pouco clara caso a wiring de DI mude.
- **Correção sugerida:** Assertar o tipo explicitamente após o `get`: `expect(queue).toBeInstanceOf(InMemoryQueueAdapter);`. Isso converte um futuro mismatch silencioso numa falha de teste autoexplicativa.

### L2 — Mutação de `process.env` sem restauração
- **Local:** linhas 18-21.
- **Descrição:** O `beforeAll` seta `NODE_ENV`, `ERP_FAIL_RATE`, `ERP_MIN/MAX_LATENCY_MS` em `process.env` e nunca os restaura. Em runner com isolamento de processo por arquivo (config padrão do Jest) isso é inofensivo, mas é uma má prática de higiene de testes e pode vazar para outras suites se a config mudar para compartilhar processo (`--runInBand` com múltiplos specs no mesmo worker, ou `testEnvironment` custom).
- **Impacto:** Acoplamento global potencial entre arquivos de teste.
- **Correção sugerida:** Salvar os valores originais e restaurá-los em `afterAll`, ou preferir injeção de config via `overrideProvider` no `TestingModule` em vez de mutar `process.env`.

### L3 — Asserção fraca em `orderId` (`toBeDefined`)
- **Local:** linha 71 (`expect(res.body.orderId).toBeDefined();`).
- **Descrição:** `toBeDefined()` passa para qualquer valor não-`undefined`, incluindo `null`, `''` ou `0`. Para um identificador de pedido isso é fraco.
- **Impacto:** Poderia mascarar um orderId vazio/malformado.
- **Correção sugerida:** `expect(res.body.orderId).toEqual(expect.any(String));` e, se houver formato (UUID/ULID), validar com regex.

### L4 — Falta cobertura de cenários de erro/edge relevantes ao domínio
- **Local:** suite inteira.
- **Descrição:** A suite cobre o caminho feliz e alguns erros, mas faltam casos de alto valor para este domínio: (a) `quantity` negativa/zero/fracionária no checkout (validação de DTO); (b) `productId` inexistente no checkout (deveria mapear para 404/erro de produto, não só catálogo); (c) idempotência com a *mesma key mas payload diferente* (deve conflitar ou retornar o original? — comportamento crítico e ambíguo que merece um teste explícito); (d) `forbidNonWhitelisted` rejeitando campo extra (ex.: `{ items: [...], foo: 1 }` → 400).
- **Impacto:** Lacunas comportamentais em regras de negócio sensíveis (idempotência e estoque).
- **Correção sugerida:** Adicionar esses casos, especialmente o (c) — same-key/different-payload é um edge de idempotência que frequentemente esconde bugs.

### L5 — `history.length >= 2` é uma asserção posicional opaca
- **Local:** linha 79.
- **Descrição:** `toBeGreaterThanOrEqual(2)` documenta "pelo menos 2 transições" mas não verifica *quais*. Se a máquina de estados regredir (ex.: pular PENDING ou registrar histórico errado), o teste ainda passa.
- **Impacto:** Cobertura frágil da máquina de estados do pedido.
- **Correção sugerida:** Assertar a sequência de status do histórico, ex.: `expect(status.body.history.map(h => h.status)).toEqual(['PENDING', 'CONFIRMED'])` (ajustando aos estados reais), tornando a transição explícita e verificável.

---

## Pontos positivos

- **Determinismo real:** uso de `queue.drain()` para sincronizar com o worker em vez de `sleep`/timeouts — elimina a principal fonte de flakiness em E2E assíncrono. Excelente.
- **Ambiente in-memory bem isolado:** `ERP_FAIL_RATE=0` e latências zeradas garantem caminho determinístico para `CONFIRMED`, sem dependência de Docker/Redis.
- **Cobertura de contrato coerente:** valida os códigos de status corretos (202 para async, 409 para estoque/duplicidade, 404/400) e o schema de erro padronizado (`statusCode`/`error`/`correlationId`).
- **Verificação de idempotência por orderId + flag replay** (95-96) testa a propriedade certa, não só o status code.
- **Cleanup adequado** no `afterAll` com `app?.close()` (optional chaining defensivo).
- Asserção de cache via métrica com label `result="hit"` (51) é a abordagem correta para observar cache hit sem acoplar a internals.

---

## Veredito

**Aprovado com ressalvas.**

A suite é funcional, determinística e idiomática. As ressalvas concentram-se em robustez/isolamento: o achado HIGH (acoplamento por estoque compartilhado, H1) e os MEDIUM de vazamento de jobs entre testes (M1), fragilidade das asserções de métrica (M2) e drift de config vs. produção (M3) devem ser endereçados antes de a suite crescer, sob risco de flakiness e de perda de valor como teste de contrato. Nenhum bloqueador crítico de correção foi encontrado.
