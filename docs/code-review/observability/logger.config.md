# Code Review — src/observability/logger.config.ts

## Resumo

`buildLoggerParams` configura o `nestjs-pino` com `correlationId`, serializadores enxutos e transporte condicional (pino-pretty em dev / JSON em prod). O desenho é sólido e bem comentado, com boa intenção de "fonte única da verdade" para o `correlationId` alinhada ao `CorrelationMiddleware`. Os principais riscos estão na confiança em headers controlados pelo cliente (injeção de header/log) e em comparações frágeis de `req.url`.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 3          |
| LOW        | 4          |

---

## HIGH

### H1 — `correlationId` derivado de header não validado (injeção de header de resposta / log)

- **Local:** linhas 21-22 (e espelhado em `correlation.middleware.ts:17,20`).
- **Descrição:** O valor de `req.headers[CORRELATION_HEADER]` é controlado pelo cliente e é usado diretamente em duas frentes: (a) `res.setHeader(CORRELATION_HEADER, id)` reflete o valor de volta na resposta; (b) o `id` vira `req.id` e é gravado em todos os logs estruturados via `customProps.correlationId`. Não há validação de formato nem limite de tamanho.
- **Impacto:**
  - **Reflexão/poluição de log:** um atacante pode injetar um `correlationId` arbitrário (ex.: caracteres de controle, payloads gigantes, sequências que confundem parsers de log/ingestão no Datadog) que será fielmente persistido nos logs e refletido na resposta. Embora o Node moderno (`http`) lance erro em `setHeader` com `\r\n` (mitigando CRLF clássico), valores muito longos ou com Unicode estranho ainda degradam a observabilidade e podem ser usados para forjar correlação entre requisições não relacionadas, atrapalhando investigações de incidente.
  - Como o `correlationId` é o eixo de rastreio do checkout (estoque/idempotência/filas), um valor forjado pelo cliente reduz a confiabilidade da auditoria.
- **Correção sugerida:** validar/sanitizar o header antes de aceitá-lo; só reutilizar se casar com um formato esperado (UUID), caso contrário gerar um novo. Centralizar essa lógica para evitar divergência entre `logger.config.ts` e `correlation.middleware.ts`.

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveCorrelationId(raw: unknown): string {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : randomUUID();
}
// genReqId:
const existing = (req as IncomingMessage & { id?: string }).id;
const id = existing ?? resolveCorrelationId(req.headers[CORRELATION_HEADER]);
```

---

## MEDIUM

### M1 — `autoLogging.ignore` por igualdade exata de `req.url` é frágil

- **Local:** linha 30 — `req.url === '/metrics' || req.url === '/health'`.
- **Descrição:** Em `pino-http` o `req.url` é a URL crua, podendo conter query string (ex.: `/metrics?format=text`) e, em outras configurações, prefixos. A comparação por igualdade estrita falha para `/health?ts=1`, `/metrics/`, ou qualquer variação, fazendo o ruído voltar a ser logado. Hoje não há prefixo global (`setGlobalPrefix` não é usado), então o caminho base bate, mas a query string quebra o filtro.
- **Impacto:** Perda do objetivo declarado ("reduzir ruído"): scrapes do Prometheus e health checks com query string passam a poluir os logs e o custo de ingestão.
- **Correção sugerida:** comparar apenas o pathname, ignorando query string, e considerar um conjunto:

```ts
const SILENCED = new Set(['/metrics', '/health']);
ignore: (req: IncomingMessage) => {
  const path = (req.url ?? '').split('?', 1)[0];
  return SILENCED.has(path);
},
```

### M2 — `customProps` pode emitir `correlationId: undefined` dependendo da ordem de execução

- **Local:** linhas 25-27.
- **Descrição:** `customProps` lê `req.id`. O comentário assume que `genReqId` já populou `req.id`, o que normalmente é verdade no `pino-http`. Porém o tipo permite `undefined` (a propriedade é opcional) e qualquer caminho de log que não passe pelo fluxo padrão de `genReqId` (ou um log emitido antes da atribuição) produziria `correlationId: undefined`. Não há fallback para o `AsyncLocalStorage` (`getCorrelationId()`), que é a fonte canônica fora do ciclo HTTP.
- **Impacto:** Logs sem `correlationId` quebram a correlação ponta-a-ponta — justamente o que o módulo existe para garantir. Em produção isso aparece como campos `correlationId` nulos esporádicos, difíceis de diagnosticar.
- **Correção sugerida:** usar o storage como fallback, garantindo um valor sempre presente:

```ts
customProps: (req: IncomingMessage) => ({
  correlationId: (req as IncomingMessage & { id?: string }).id ?? getCorrelationId(),
}),
```

### M3 — Asserção de tipo `as string` em header que pode ser `string[]`

- **Local:** linha 21 — `(req.headers[CORRELATION_HEADER] as string)`.
- **Descrição:** `req.headers[name]` é `string | string[] | undefined`. Headers duplicados (ex.: dois `x-correlation-id`) chegam como `string[]`. O `as string` mente para o compilador; o valor real seria um array, que viraria `id` e seria passado a `res.setHeader` e usado nos logs.
- **Impacto:** Com header duplicado, `id` seria um array — `setHeader` o serializa de forma inesperada e o log carrega um array onde se espera string. Combinado com H1, amplia a superfície de manipulação.
- **Correção sugerida:** normalizar para string (a função `resolveCorrelationId` de H1, que checa `typeof === 'string'`, já cobre isso ao rejeitar arrays e gerar um UUID novo).

---

## LOW

### L1 — Parâmetro `res` não utilizado em `customProps`/serializers e ausência de validação de `level`

- **Local:** linha 10 (`level: string`).
- **Descrição:** `level` é repassado direto ao `pinoHttp.level` sem validação. Um valor inválido (ex.: typo em env var) faz o pino lançar na inicialização — o que é aceitável (fail-fast), mas não há mensagem de domínio. Como `AppConfig.logLevel` provavelmente já valida, é apenas defesa em profundidade.
- **Impacto:** Baixo; falha de boot com mensagem genérica do pino se a config a montante não validar.
- **Correção sugerida:** opcionalmente tipar `level` como union de níveis válidos (`'fatal' | 'error' | ... | 'trace'`) para validação em tempo de compilação no ponto de chamada.

### L2 — `transport` com `pino-pretty` em dev acopla dependência de runtime implícita

- **Local:** linhas 39-41.
- **Descrição:** O transporte só referencia `pino-pretty` quando `isDev`. Se a dependência não estiver instalada no ambiente de dev, o pino falha ao iniciar a thread de transporte com erro pouco óbvio. Não é um bug, mas convém garantir que `pino-pretty` esteja em `dependencies`/`devDependencies` e documentado.
- **Impacto:** Baixo; afeta apenas DX em dev.
- **Correção sugerida:** confirmar presença de `pino-pretty` no `package.json` e comentar o requisito.

### L3 — Tipos de serializer locais e frouxos divergem dos tipos reais do pino

- **Local:** linhas 33-37.
- **Descrição:** Os serializers tipam `req`/`res` como objetos literais mínimos (`{ method: string; url: string }`, `{ statusCode: number }`) em vez de usar os tipos do `pino-http`/Node. Funciona, mas perde checagem caso se queira logar mais campos e mascara o fato de `req`/`res` serem objetos muito maiores.
- **Impacto:** Manutenibilidade; risco de assumir campos ausentes ao evoluir o serializer.
- **Correção sugerida:** usar `SerializedRequest`/`SerializedResponse` do pino ou ao menos `IncomingMessage`/`ServerResponse` com pick explícito.

### L4 — Lógica de resolução de `correlationId` duplicada entre middleware e logger

- **Local:** linhas 19-24 vs. `correlation.middleware.ts:15-20`.
- **Descrição:** A regra "`req.id` || header || `randomUUID()`" e o `res.setHeader` existem em dois lugares. O comentário reconhece a intenção de alinhamento, mas a duplicação convida à divergência (ex.: corrigir H1/M3 em um arquivo e esquecer o outro).
- **Impacto:** Manutenibilidade; risco de drift entre as duas fontes.
- **Correção sugerida:** extrair um helper compartilhado (ex.: `resolveCorrelationId(req)`/`ensureCorrelationHeader(req, res)`) em `correlation.ts` e consumi-lo nos dois pontos.

---

## Pontos positivos

- Intenção de **fonte única da verdade** para `correlationId`, com `genReqId` reusando `req.id` setado pelo middleware — desenho correto para manter logs, header de resposta e `AsyncLocalStorage` alinhados independentemente da ordem.
- **Separação dev/prod** do transporte: JSON puro em produção (ideal para coletores) e pretty em dev.
- **Serializers enxutos** evitam vazar payloads/headers sensíveis nos logs (boa postura de segurança por omissão).
- **`base: { service }`** e `customProps` bem posicionados; função pura e facilmente testável (recebe config por parâmetro, sem efeitos colaterais além do retorno de objeto).
- Aderência arquitetural correta: é adapter de infraestrutura de observabilidade, não vaza no domínio; consumido via `LoggerModule.forRootAsync` com `AppConfig` injetado (sem segundo `loadConfig`).

## Veredito

**Aprovado com ressalvas.** O arquivo está bem estruturado e idiomático. Recomenda-se endereçar **H1** (validação do header de correlação, com impacto em segurança/observabilidade) e **M1/M2** (filtro de URL frágil e fallback de `correlationId`) antes de considerar produção endurecida. Os achados LOW são melhorias de manutenibilidade. Não há testes unitários para este arquivo (`logger.config.spec.ts` ausente); como é uma função pura, vale cobrir `genReqId` (reuso de `req.id`, header válido/ inválido, geração de UUID), `ignore` e a seleção de `transport`.
