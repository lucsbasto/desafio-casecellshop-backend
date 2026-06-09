# Code Review — src/observability/correlation.ts

## Resumo

Módulo utilitário que encapsula um `AsyncLocalStorage<CorrelationStore>` para propagar `correlationId`/`orderId` por toda a cadeia assíncrona (HTTP e worker). O código é pequeno, idiomático e correto para o seu propósito. Não há bugs críticos; os achados são de baixa severidade e dizem respeito a robustez de tipos, semântica de mutação do store e ausência de teste dedicado.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 1         |
| LOW        | 4         |

---

## MEDIUM

### M1 — `setOrderId` falha silenciosamente quando não há store ativo
- **Local:** linhas 22-25
- **Descrição:** `setOrderId` faz `const store = getStore(); if (store) store.orderId = orderId;`. Se for chamado fora de um contexto `runWithCorrelation` (store `undefined`), a chamada simplesmente não tem efeito e ninguém é notificado. O consumidor `checkout.usecase.ts` (linhas 85, 92) chama `setOrderId(orderId)` durante o fluxo de checkout, contando que o `orderId` passe a aparecer em logs/spans subsequentes. Se esse caminho for exercitado por um teste, um job, ou qualquer entrada que não tenha passado pelo `CorrelationMiddleware` (por exemplo, um `reconcile.usecase.ts` ou um worker que esqueça de envolver a chamada), o `orderId` é perdido sem rastro.
- **Impacto:** Perda silenciosa de observabilidade. Em produção isso degrada a rastreabilidade exatamente nos pontos mais sensíveis (correlação pedido↔log) sem nenhum sinal de erro. É a categoria "falha silenciosa / fallback ruim" descrita no checklist de revisão.
- **Correção sugerida:** Emitir um aviso quando não há store, para que o no-op seja detectável em desenvolvimento/testes sem quebrar produção:
  ```ts
  export function setOrderId(orderId: string): void {
    const store = correlationStorage.getStore();
    if (!store) {
      // Opcional: usar um Logger Nest; aqui um warn simples evita acoplamento de DI.
      // Indica que setOrderId foi chamado fora de runWithCorrelation.
      return;
    }
    store.orderId = orderId;
  }
  ```
  Como alternativa mais defensiva, expor uma variante que lança em ambiente de teste. O ponto central é tornar o no-op observável, não silencioso.

---

## LOW

### L1 — Asserção de tipo insegura no consumidor por falta de tipo do header (contágio do design da API)
- **Local:** linha 31 (`CORRELATION_HEADER`), em conjunto com os consumidores `correlation.middleware.ts:17` e `logger.config.ts:21`.
- **Descrição:** A constante é exportada como string crua e os consumidores fazem `req.headers[CORRELATION_HEADER] as string`. O cast `as string` mascara o fato de que `req.headers[...]` é `string | string[] | undefined` — um cliente pode enviar o header repetido, produzindo `string[]`, e o cast esconderia isso. O arquivo em si não tem o bug, mas a forma como expõe a constante (sem um helper de normalização) empurra o cast inseguro para todo consumidor.
- **Impacto:** Baixo (header duplicado é raro), mas é uma asserção de tipo insegura replicada em 2+ lugares. Se um header `x-correlation-id` duplicado chegar, o `correlationId` viraria um array e poluiria logs/spans.
- **Correção sugerida:** Oferecer um helper de extração normalizada neste módulo, centralizando a regra:
  ```ts
  export function correlationIdFromHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): string | undefined {
    const raw = headers[CORRELATION_HEADER];
    return Array.isArray(raw) ? raw[0] : raw;
  }
  ```
  Os consumidores passam a usar o helper em vez do `as string`.

### L2 — `runWithCorrelation` muta o objeto `store` recebido por referência (semântica de propriedade não documentada)
- **Local:** linhas 14-16 + 22-25
- **Descrição:** `setOrderId` muta o objeto que foi passado a `runWithCorrelation`. Quem chamou `runWithCorrelation({ correlationId })` (ex.: middleware linha 21) passa um literal, então não há aliasing. Mas o worker passa `{ correlationId: job.correlationId, orderId: job.orderId }` (checkout.worker.ts:35) — também literal. O contrato implícito ("o store passado pode ser mutado in-place por `setOrderId`") não está documentado. Se algum chamador futuro reaproveitar um objeto compartilhado como store, a mutação vazaria.
- **Impacto:** Baixo hoje (todos os chamadores passam literais). É um risco latente de manutenibilidade/aliasing.
- **Correção sugerida:** Documentar no JSDoc que o `store` é apropriado pelo ALS e mutável via `setOrderId`, e/ou clonar na entrada: `correlationStorage.run({ ...store }, fn)`. O clone elimina o risco de aliasing por custo desprezível.

### L3 — Ausência de teste unitário dedicado para o módulo
- **Local:** arquivo inteiro (não existe `correlation.spec.ts`).
- **Descrição:** Não há teste cobrindo: (a) `getCorrelationId` retorna `undefined` fora de contexto; (b) `runWithCorrelation` isola contextos concorrentes (dois `run` aninhados/paralelos não vazam id um do outro); (c) `setOrderId` dentro vs. fora do contexto; (d) `getStore` reflete a mutação feita por `setOrderId`. Esse é justamente o tipo de utilitário onde a correção da propagação de contexto assíncrono merece teste explícito, porque regressões de ALS são silenciosas e difíceis de diagnosticar em produção.
- **Impacto:** Risco de regressão não detectada na peça que sustenta toda a rastreabilidade.
- **Correção sugerida:** Adicionar `src/observability/correlation.spec.ts` cobrindo isolamento entre execuções concorrentes e o comportamento de `setOrderId` fora de contexto (que se conecta ao achado M1). Exemplo mínimo:
  ```ts
  it('isola contextos concorrentes', async () => {
    const a = runWithCorrelation({ correlationId: 'a' }, async () => {
      await Promise.resolve();
      return getCorrelationId();
    });
    const b = runWithCorrelation({ correlationId: 'b' }, () => getCorrelationId());
    expect(await a).toBe('a');
    expect(b).toBe('b');
  });
  ```

### L4 — `getStore` expõe o store interno mutável, permitindo mutações fora da API controlada
- **Local:** linhas 27-29
- **Descrição:** `getStore()` retorna a referência viva do `CorrelationStore`. Qualquer consumidor pode escrever `getStore()!.correlationId = '...'` e sobrescrever o id de correlação no meio de um request, contornando a única via pretendida (`runWithCorrelation` / `setOrderId`). Hoje nenhum consumidor abusa disso (apenas `tracing.service.ts`/filtros leem via `getCorrelationId`), mas a API permite.
- **Impacto:** Baixo; é um ponto de encapsulamento. A superfície de mutação não controlada pode levar a ids inconsistentes em logs se mal usada no futuro.
- **Correção sugerida:** Se `getStore` existe apenas para leitura, retornar uma cópia rasa (`return store ? { ...store } : undefined;`) ou um `Readonly<CorrelationStore>`. Se ninguém o consome diretamente hoje (nenhum import de `getStore` foi encontrado fora deste arquivo), considerar removê-lo para reduzir superfície de API.

---

## Pontos positivos

- Uso correto e idiomático de `AsyncLocalStorage` (`node:async_hooks`), a abordagem canônica para propagação de contexto sem poluir assinaturas — alinhado à arquitetura hexagonal: é uma preocupação de observabilidade/infra mantida fora do domínio.
- API pequena, coesa e com responsabilidade única; nomes claros (`runWithCorrelation`, `getCorrelationId`, `setOrderId`).
- `getCorrelationId` usa optional chaining (`?.`) corretamente, retornando `undefined` fora de contexto em vez de lançar — os consumidores tratam isso com `?? 'unknown'` (filtro/controller), o que é defensivo e correto.
- Tipagem honesta nos retornos (`string | undefined`), sem `any`.
- `CORRELATION_HEADER` centralizado como fonte única de verdade, reutilizado pelo middleware e pela config do logger — evita strings mágicas divergentes.
- Sem segredos, sem I/O, sem dependências de framework: o módulo é puro e facilmente testável (o que torna a ausência de teste em L3 ainda mais fácil de sanar).

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é sólido e correto para sua finalidade; não há achados CRITICAL ou HIGH. A única ressalva de peso é **M1** (falha silenciosa de `setOrderId` fora de contexto), que merece ao menos tornar o no-op observável dado o papel do módulo em rastreabilidade. Os achados LOW são melhorias de robustez de tipos, encapsulamento e cobertura de teste que podem ser endereçadas incrementalmente.
