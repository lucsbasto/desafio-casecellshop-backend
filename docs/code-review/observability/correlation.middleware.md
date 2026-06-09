# Code Review — src/observability/correlation.middleware.ts

## Resumo

O middleware é pequeno, idiomático para NestJS e cumpre seu objetivo: inicializar o `AsyncLocalStorage` de correlação por requisição e alinhar o `correlationId` entre logs (pino-http), métricas, spans e o header de resposta. A lógica de fallback (`req.id` → header → UUID) é coerente com `logger.config.ts`. Os principais riscos são tratamento de entrada não confiável (header controlado pelo cliente refletido sem validação) e a asserção de tipo `as string` que ignora o caso de header repetido (array).

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## HIGH

### H1 — `as string` em `req.headers[CORRELATION_HEADER]` ignora header repetido (array) e entrada não validada

- **Local:** linhas 16-17 (`(req.headers[CORRELATION_HEADER] as string)`), propagado para linhas 19-20.
- **Descrição:** `req.headers[name]` em Express/Node tem tipo `string | string[] | undefined`. Para a maioria dos headers customizados como `x-correlation-id`, **se o cliente enviar o header duas vezes**, o Node entrega um **array** (`string[]`), não uma string. A asserção `as string` mente para o compilador: em runtime, `correlationId` vira um array. Consequências:
  - `res.setHeader(CORRELATION_HEADER, correlationId)` com array seta múltiplos headers (comportamento inesperado).
  - `reqWithId.id = correlationId` viola o contrato `id?: string` (linha 15) — pino-http e `customProps` passam a logar um array como correlationId.
  - Além do array, o valor é **totalmente controlado pelo cliente** e é injetado em logs, spans e header de resposta sem qualquer validação de formato/comprimento. Um cliente pode enviar um valor gigante (poluição de logs / custo de ingestão) ou com caracteres de controle. Caracteres CR/LF fazem `res.setHeader` lançar `ERR_INVALID_CHAR`, gerando um 500 não tratado neste ponto inicial do pipeline (antes de qualquer filtro de exceção customizado já estar no contexto ALS).
- **Impacto:** Quebra de tipo silenciosa, possível corrupção de correlação em logs/observabilidade, e superfície de log injection / DoS de log por entrada não confiável. Em um fluxo de checkout com idempotência e rastreamento, um `correlationId` corrompido prejudica a investigação de incidentes.
- **Correção sugerida:** Normalizar para string única e validar/sanitizar (formato e comprimento). Ex.:

```ts
import { randomUUID } from 'node:crypto';

const MAX_CID_LEN = 128;
// Aceita apenas caracteres seguros para header/log; ajuste conforme padrão desejado.
const SAFE_CID = /^[A-Za-z0-9._-]{1,128}$/;

function pickHeaderCorrelationId(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const trimmed = value.slice(0, MAX_CID_LEN);
  return SAFE_CID.test(trimmed) ? trimmed : undefined;
}

use(req: Request, res: Response, next: NextFunction): void {
  const reqWithId = req as Request & { id?: string };
  const correlationId =
    reqWithId.id ||
    pickHeaderCorrelationId(req.headers[CORRELATION_HEADER]) ||
    randomUUID();
  reqWithId.id = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelation({ correlationId }, () => next());
}
```

> Observação: a mesma normalização deve ser aplicada em `logger.config.ts:21` (`genReqId`), que tem exatamente o mesmo `as string` não validado, para manter as duas fontes consistentes.

---

## MEDIUM

### M1 — Duplicação da lógica de derivação do correlationId entre middleware e `genReqId`

- **Local:** linhas 16-20 vs. `logger.config.ts:19-24`.
- **Descrição:** A regra `req.id || header || randomUUID()` + `res.setHeader(...)` está escrita duas vezes (middleware e `genReqId` do pino-http). Embora os comentários expliquem que isso é intencional para tolerar ordem de execução, a duplicação faz com que qualquer mudança de política (validação, formato, comprimento — ver H1) precise ser replicada manualmente, com risco de divergência. Hoje, se a validação for adicionada só em um lado, as duas fontes podem produzir IDs diferentes.
- **Impacto:** Manutenibilidade e risco de drift sutil entre header de resposta e `req.id` logado.
- **Correção sugerida:** Extrair uma função pura compartilhada (ex.: `resolveCorrelationId(req): string` em `correlation.ts`) usada tanto pelo middleware quanto por `genReqId`, centralizando normalização/validação.

### M2 — `res.setHeader` pode lançar e abortar a cadeia antes de estabelecer o contexto ALS

- **Local:** linhas 20-21.
- **Descrição:** `res.setHeader` é chamado **antes** de `runWithCorrelation`. Se ele lançar (ex.: caractere inválido vindo do header — ver H1), a exceção sobe sem que `next()` tenha sido chamado e sem contexto de correlação ativo, resultando em resposta de erro sem `correlationId` e sem o header refletido — justamente quando rastrear seria mais útil. Mesmo com H1 corrigido (sanitização), vale considerar a ordem.
- **Impacto:** Falha de observabilidade na borda em casos de erro de entrada.
- **Correção sugerida:** Com a sanitização de H1 o valor passa a ser sempre seguro para header, eliminando o lançamento. Alternativamente, envolver a chamada em `try/catch` ou setar o header dentro do escopo do `runWithCorrelation`. A correção de H1 já mitiga o problema na prática.

---

## LOW

### L1 — Asserção de tipo `req as Request & { id?: string }` repetida e frágil

- **Local:** linha 15.
- **Descrição:** O campo `id` é uma extensão de `pino-http`/`express` aplicada via cast inline. Repetido aqui e em `logger.config.ts`/`customProps`. Um augmentation de módulo (`declare module 'express'` ou `declare module 'http'`) tornaria `req.id` tipado globalmente, eliminando casts.
- **Impacto:** Cosmético / manutenibilidade.
- **Correção sugerida:** Declarar a extensão de tipo uma vez (ex.: `types/express.d.ts`) e remover os casts.

### L2 — Comentários em inglês em base predominantemente comentada em português

- **Local:** linhas 13-14, 18.
- **Descrição:** Os comentários estão em inglês enquanto `correlation.ts` e outros arquivos do módulo usam português. Inconsistência menor de idioma.
- **Impacto:** Cosmético.
- **Correção sugerida:** Padronizar o idioma dos comentários no módulo de observabilidade.

### L3 — `runWithCorrelation({ correlationId }, () => next())` não propaga `orderId` inicial

- **Local:** linha 21.
- **Descrição:** Comportamento correto e esperado (o `orderId` é preenchido depois via `setOrderId`), mas vale registrar que o store inicia apenas com `correlationId`. Nenhuma ação necessária; apenas confirmação de que o `CorrelationStore.orderId` opcional é preenchido tardiamente e não na borda.
- **Impacto:** Nenhum (informativo).
- **Correção sugerida:** N/A — manter como está.

---

## Pontos positivos

- Uso correto de `AsyncLocalStorage` via wrapper `runWithCorrelation`, garantindo propagação de contexto por toda a cadeia assíncrona da requisição.
- Boa aderência hexagonal: é um adapter de infraestrutura puro (camada de observabilidade), sem vazamento de domínio; depende apenas do módulo `correlation` local.
- Idiomático em NestJS: `@Injectable()` implementando `NestMiddleware`, registrado corretamente via `MiddlewareConsumer` em `forRoutes('*')`.
- Alinhamento deliberado com `pino-http genReqId` (`req.id`), evitando divergência entre logs, header de resposta e spans — a intenção está bem documentada nos comentários.
- Sem catches vazios, sem perda de stack, sem `await` em loop; complexidade mínima.

---

## Veredito

**Aprovado com ressalvas.** O middleware está funcionalmente correto no caminho feliz e bem integrado à stack de observabilidade. Antes de produção, recomenda-se tratar **H1** (normalizar header para string única + validar formato/comprimento de entrada não confiável), idealmente extraindo a lógica compartilhada (**M1**) para também cobrir `genReqId` em `logger.config.ts`. Os itens MEDIUM/LOW restantes são de robustez e manutenibilidade.
