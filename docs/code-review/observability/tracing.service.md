# Code Review — src/observability/tracing.service.ts

## Resumo

`TracingService` é um tracer in-memory baseado em ring buffer (stub justificado, com API
deliberadamente compatível com OpenTelemetry). O código é pequeno, coeso e a lógica do ring
buffer está **correta**. Os achados são de baixo a médio impacto: o principal é a perda do erro
original quando um valor não-`Error` é lançado dentro de `withSpan`, além de pequenas questões de
robustez de tipos e ausência de testes para a aritmética modular do buffer.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## MEDIUM

### M1 — `withSpan` pode mascarar o erro original ao serializar a mensagem (linha 63)

**Local:** linha 63 — `span.end({ status: 'error', error: (err as Error).message });`

**Descrição:** A asserção `(err as Error)` é insegura. Em JavaScript/TS qualquer valor pode ser
lançado (`throw 'boom'`, `throw undefined`, `throw { code: 'X' }`). Se `err` for `null` ou
`undefined`, acessar `.message` lança um novo `TypeError`. Como esse acesso ocorre **dentro do
bloco `catch`, antes do `throw err`**, a exceção do `TypeError` propaga no lugar do erro original
— perdendo completamente a causa real da falha. Para valores não-nulos que não são `Error`
(string, objeto), `.message` resulta em `undefined` e a observabilidade registra `error: undefined`,
escondendo a informação útil.

**Impacto:** Falha silenciosa / perda de stack e de causa raiz. Em um worker de checkout
(`checkout.worker.ts` usa `withSpan('worker.process', ...)` e `withSpan('erp.invoice', ...)`),
um erro lançado como não-`Error` por uma lib de terceiros (ERP/HTTP client) poderia ser
convertido em `TypeError: Cannot read properties of undefined (reading 'message')`, atrapalhando
retry/diagnóstico e poluindo logs com a exceção errada.

**Correção sugerida:** normalizar o erro defensivamente sem nunca lançar dentro do catch:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  span.end({ status: 'error', error: message });
  throw err;
}
```

Opcionalmente registrar também `errorType: err instanceof Error ? err.name : typeof err` para
melhor triagem.

### M2 — Span pode ser finalizado mais de uma vez (dupla contagem) (linhas 39-48)

**Local:** linhas 39-48 (`end`) e 68-72 (`record`).

**Descrição:** O objeto `Span` retornado por `startSpan` não tem proteção contra múltiplas chamadas
de `end()`. Se o chamador chamar `end()` duas vezes (erro comum, ou interação com `withSpan` se o
mesmo span for reaproveitado), o ring buffer grava **duas entradas** para o mesmo span, com
durações diferentes, distorcendo métricas/diagnóstico. A API OTel real torna `end()` idempotente
(chamadas subsequentes são no-op), então este stub diverge do contrato que afirma emular (linha 11).

**Impacto:** Dupla contagem de spans e durações inconsistentes na inspeção; comportamento divergente
do OTel real, o que contraria o objetivo declarado de "swap fácil".

**Correção sugerida:** guardar um flag de finalização por span:

```ts
let ended = false;
return {
  name,
  end(extra: Record<string, unknown> = {}): void {
    if (ended) return;
    ended = true;
    // ... record(...)
  },
};
```

---

## LOW

### L1 — `withSpan` é a única forma "segura"; `startSpan` manual não tem garantia de `end` (linhas 33-49)

**Local:** linhas 33-49.

**Descrição:** Quem usa `startSpan` diretamente é responsável por chamar `end()`; se esquecer (ou se
uma exceção ocorrer antes do `end`), o span nunca é registrado e a duração se perde silenciosamente.
Não é um bug do serviço em si, mas é um pé-de-ratoeira de API.

**Impacto:** Spans perdidos / observabilidade incompleta em caminhos que usam `startSpan` cru.

**Correção sugerida:** documentar que `withSpan` é o caminho preferido, ou expor apenas `withSpan`
publicamente e manter `startSpan` para casos avançados com aviso explícito no JSDoc. No código atual
os dois usos reais já passam por `withSpan`, o que é bom.

### L2 — Atributos não são copiados em profundidade nem sanitizados (linha 45)

**Local:** linha 45 — `attributes: { ...attributes, ...extra }`.

**Descrição:** O spread é raso: valores aninhados (objetos/arrays passados como atributo) são
referências compartilhadas com o chamador, podendo ser mutados depois do `end()` e alterar o que o
buffer "registrou". Além disso, atributos arbitrários (`Record<string, unknown>`) podem conter dados
sensíveis (PII, tokens) que acabam expostos via `recentSpans()` / endpoint de diagnóstico, se este
for exposto sem authz.

**Impacto:** Baixo no estado atual (uso interno controlado), mas é um vetor de exposição de dados se
`recentSpans()` for servido por um controller sem guard, e fonte potencial de registros mutáveis.

**Correção sugerida:** para o stub, aceitável; ao plugar OTel real, garantir redaction de atributos
sensíveis e tratar `recentSpans()` como endpoint protegido (authz/guard), nunca público.

### L3 — Conversão `Number(bigint)` perde precisão para durações muito longas e ausência de testes (linha 40)

**Local:** linha 40 — `Number(process.hrtime.bigint() - startedAt) / 1e6`.

**Descrição:** (a) `Number()` sobre a diferença em nanossegundos só perde precisão acima de
~104 dias de duração de span — irrelevante na prática, apenas anote. (b) Mais relevante: **não há
arquivo de teste** (`tracing.service.spec.ts` inexistente). A aritmética modular do ring buffer
(`writeIdx`, `start = count < max ? 0 : writeIdx`, ordem oldest-to-newest no wrap-around) é
exatamente o tipo de lógica off-by-one que merece testes — incluindo o caso de overflow do buffer
(>1000 spans) e a ordem retornada após wrap.

**Impacto:** Regressões na ordenação/janela do buffer passariam despercebidas.

**Correção sugerida:** adicionar `tracing.service.spec.ts` cobrindo: (1) menos de `maxBuffer` spans
retornam em ordem de inserção; (2) exatamente `maxBuffer`; (3) overflow (ex.: 1500 spans) descarta
os mais antigos e mantém ordem oldest-to-newest; (4) `correlationId` propagado via
`runWithCorrelation`; (5) `withSpan` registra `status: 'error'` e re-lança em caso de exceção,
inclusive quando o lançado não é `Error` (cobre M1).

---

## Pontos positivos

- **Ring buffer correto e eficiente:** escrita O(1), memória limitada, sem reindexação de array; a
  leitura em `recentSpans()` calcula corretamente o ponto de início antes/depois do wrap-around.
- **Concorrência:** mutações de `writeIdx`/`count`/`record` são síncronas; no modelo single-thread do
  Node não há race condition — adequado.
- **Aderência hexagonal:** `TracingService` é uma preocupação de infraestrutura/observabilidade,
  isolada em seu módulo `@Global`, exportada e consumida via DI; não vaza para o domínio.
- **API OTel-compatível** (`startSpan`/`end`) e stub honestamente documentado (linhas 4-12),
  facilitando o swap futuro pelo SDK real.
- **Correlação:** integração limpa com `AsyncLocalStorage` via `getCorrelationId()`; tipos
  consistentes (`string | undefined` ↔ `correlationId?: string`).
- **Idiomático NestJS:** `@Injectable`, provider singleton (escopo default) — correto para um buffer
  compartilhado de diagnóstico.

---

## Veredito

**Aprovado com ressalvas.** O arquivo está sólido na sua responsabilidade central (ring buffer e
correlação). Recomenda-se endereçar **M1** (perda do erro original ao serializar mensagem de
não-`Error`) antes do merge, por ser uma falha silenciosa real em caminho de erro de worker; **M2**
e os LOW podem ser tratados como follow-up, sendo a adição de testes (L3) a melhoria de maior
valor para a manutenibilidade.
