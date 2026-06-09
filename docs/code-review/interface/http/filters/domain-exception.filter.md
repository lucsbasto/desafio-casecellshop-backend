# Code Review — src/interface/http/filters/domain-exception.filter.ts

O filtro é coeso, tipado em `unknown` e mantém o domínio agnóstico de HTTP via `statusFor`. A maior fragilidade é de observabilidade: erros de domínio (ou framework) que terminam em **500** não geram nenhum log, criando 500s silenciosos. Há ainda vazamento do nome interno do framework no campo `error` e casts inseguros ao parsear o corpo de `HttpException`.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 2         |
| MEDIUM     | 3         |
| LOW        | 3         |

---

## HIGH

### H1 — 500 silencioso para `DomainError`/`HttpException` não logado
**Local:** linhas 49-63 (ramos `HttpException` e `DomainError`) vs. 64-75 (único ramo que loga).

**Descrição:** O log de erro só acontece no ramo `else` (exceções não tratadas). Porém:
- Um `DomainError` cujo tipo concreto não está mapeado em `statusFor` cai no fallback `INTERNAL_SERVER_ERROR` (linha 33) e responde **500 sem nenhum log**.
- Um `HttpException` com `getStatus()` 5xx (ex.: `InternalServerErrorException`, `ServiceUnavailableException`, ou erros 5xx propagados pelo Nest) também responde 5xx **sem log**.

**Impacto:** 500 silencioso em produção. O cliente recebe 500, mas não há rastro em log/stack para diagnóstico — justamente o cenário que mais precisa de observabilidade. Em e-commerce de checkout isso esconde falhas reais (estoque, fila, Redis) sob status genérico.

**Correção sugerida:** Logar sempre que `statusCode >= 500`, independente do ramo, idealmente após calcular o `statusCode` e antes de responder. Ex.:

```ts
if (statusCode >= 500) {
  const stack = exception instanceof Error ? exception.stack : JSON.stringify(exception);
  this.logger.error(
    `5xx [${correlationId}] ${error}: ${message}`,
    stack,
  );
}
```

E remover o log duplicado do ramo `else` (passa a ser coberto por essa checagem).

---

### H2 — Campo `error` vaza o nome interno do framework para o cliente
**Local:** linha 53 (`error = exception.name;`).

**Descrição:** Para `HttpException`, `error` recebe `exception.name`, que é o nome da classe Nest (`BadRequestException`, `UnauthorizedException`, `NotFoundException`, etc.). Para erros 5xx isso pode expor `InternalServerErrorException`.

**Impacto:** O `ErrorDto.error` é documentado como um código estável (`INSUFFICIENT_STOCK`, ...). Expor nomes de classe do NestJS (a) acopla o contrato público a detalhes de implementação do framework e (b) revela a stack tecnológica a clientes externos (information disclosure leve). Clientes que façam switch no campo `error` quebram se o Nest renomear classes.

**Correção sugerida:** Derivar `error` de um mapa estável status->código, ou usar a constante de status do Nest. Ex.:

```ts
error = HttpStatus[statusCode] ?? 'HTTP_ERROR'; // 'BAD_REQUEST', 'NOT_FOUND', ...
```

Mantém o contrato previsível e desacoplado dos nomes de classe do framework.

---

## MEDIUM

### M1 — Casts inseguros ao parsear `getResponse()`
**Local:** linhas 54-59.

**Descrição:** `exception.getResponse()` retorna `string | object`. O código trata `string`, mas no ramo `object` faz `(body as { message?: unknown }).message` sem garantir que `body` é um objeto não-nulo. `getResponse()` em teoria nunca retorna `null`, mas como o tipo é `object` arbitrário, um filtro reutilizado/subclasse customizada pode entregar um shape inesperado, e os casts encadeados (`as { message: string[] }`) são asserções não verificadas.

**Impacto:** Risco de `TypeError` dentro do próprio exception filter — o pior lugar para lançar, pois cai no handler de erro padrão do Nest e mascara o erro original. Também há fragilidade de tipos: as três asserções `as` desligam a checagem do compilador.

**Correção sugerida:** Extrair um helper defensivo que valide o shape:

```ts
function extractMessage(body: string | object, fallback: string): string {
  if (typeof body === 'string') return body;
  const m = (body as Record<string, unknown>)?.message;
  if (Array.isArray(m)) return m.map(String).join('; ');
  if (typeof m === 'string') return m;
  return fallback;
}
```

### M2 — `message` de erro de domínio enviado cru ao cliente
**Local:** linha 63 (`message = (exception as Error).message;`) e linha 67.

**Descrição:** A mensagem do `DomainError` é repassada literalmente na resposta. Hoje as mensagens de domínio incluem identificadores (`Produto ${productId} não encontrado`, `Pedido ${orderId} não encontrado`). Isso é aceitável para 4xx de negócio, mas convém confirmar que nenhuma mensagem de domínio futura embuta dado sensível (preço interno, IDs internos, detalhes de infra).

**Impacto:** Superfície de information disclosure caso novas `DomainError` carreguem detalhes internos. Para 500, a mensagem genérica (linha 67) está correta — bom. O risco é só nos 4xx de domínio à medida que o catálogo de erros cresce.

**Correção sugerida:** Documentar a convenção "mensagens de DomainError são seguras para o cliente" (ou um flag `clientSafe` no `DomainError`). Sem mudança de código imediata, mas vale a guarda explícita.

### M3 — Ausência de teste para o filtro
**Local:** arquivo inteiro (nenhum `domain-exception.filter.spec.ts` encontrado).

**Descrição:** Não há teste cobrindo o filtro, apesar de conter lógica de mapeamento não trivial (4 ramos de status, parse de array de validação, fallback de erro não-Error, fallback de correlationId).

**Impacto:** Regressões silenciosas: mudança em `statusFor`, no parse de `getResponse()`, ou no contrato do `ErrorDto` não seriam detectadas. É código de borda crítico (toda resposta de erro da API passa por aqui).

**Correção sugerida:** Adicionar testes unitários com um `ArgumentsHost` mockado cobrindo: `HttpException` com `message` array (validação class-validator), `HttpException` com string, `InsufficientStockError` -> 409, `ProductNotFoundError` -> 404, `DuplicateRequestError` -> 409 e `error === 'DUPLICATE_REQUEST'`, erro genérico `Error` -> 500 + log com stack, throw não-Error `{ foo: 1 }` -> 500 + log serializado, e ausência de correlationId -> `'unknown'`.

---

## LOW

### L1 — `instanceof DuplicateRequestError` redundante no guard
**Local:** linha 60 (`exception instanceof DomainError || exception instanceof DuplicateRequestError`).

**Descrição:** `DuplicateRequestError` **não** estende `DomainError` (estende `Error` direto, em checkout.usecase.ts:31), por isso o `|| instanceof DuplicateRequestError` é necessário hoje — não é redundante. Porém a duplicação da checagem aqui e em `statusFor` (linha 29) indica modelagem inconsistente: um erro de domínio mora na camada de aplicação e fora da hierarquia `DomainError`.

**Impacto:** Manutenção: qualquer novo erro "tipo domínio" definido fora de `DomainError` exige editar dois pontos (o guard e `statusFor`) ou será tratado como 500 silencioso. Acoplamento do filtro (interface) a um símbolo da camada de aplicação (linha 10).

**Correção sugerida:** Fazer `DuplicateRequestError extends DomainError` (passando `code` ao super) e movê-lo para `domain/errors.ts`. O guard vira só `instanceof DomainError` e o import da camada de aplicação some.

### L2 — `error` para `DuplicateRequestError` depende de cast frágil
**Local:** linha 62 (`(exception as DomainError).code ?? exception.name`).

**Descrição:** Como `DuplicateRequestError` não é `DomainError`, o cast `as DomainError` é uma asserção falsa que só funciona porque a classe coincidentemente também tem `.code`. Além disso, `DuplicateRequestError` não seta `this.name`, então o fallback `exception.name` seria `'Error'` (não `'DuplicateRequestError'`) — só não importa porque `.code` existe. É correto por coincidência, não por design.

**Impacto:** Frágil a refactors. Resolvido junto com L1 (unificar sob `DomainError`).

### L3 — `new Date().toISOString()` e formatação repetida por exceção
**Local:** linha 82.

**Descrição:** Alocação de `Date` por exceção — irrelevante em volume normal. Mencionado apenas para completude; não é gargalo.

**Impacto:** Nenhum prático.

**Correção sugerida:** Nenhuma ação necessária.

---

## Pontos positivos

- Tipagem de entrada como `unknown` (linha 40) em vez de `any` — força narrowing seguro.
- `statusFor` isolado e bem comentado mantém o domínio agnóstico de HTTP (aderência hexagonal correta: a tradução domínio->HTTP vive na camada de interface).
- Tratamento explícito de throws não-`Error` (linhas 70-74) com serialização via `JSON.stringify`, evitando log `undefined` — detalhe maduro frequentemente esquecido.
- Junção de mensagens de validação do class-validator (`message.join('; ')`, linha 58) produz erro 400 legível.
- Fallback de `correlationId` para `'unknown'` (linha 43) evita `undefined` no payload.
- Resposta sempre padronizada via `ErrorDto`, alinhada à documentação OpenAPI.
- `@Catch()` sem argumentos como filtro global catch-all é o uso idiomático correto para um handler de último recurso.

---

## Veredito

**Aprovado com ressalvas.**

O filtro funciona e está bem estruturado, mas duas ressalvas devem ser endereçadas antes de considerar produção-ready: **H1** (500s silenciosos sem log — risco operacional real em checkout) e **H2** (vazamento do nome de classe do framework no contrato público). M1 (casts inseguros dentro do próprio filtro) e M3 (ausência de testes) são fortemente recomendados na sequência. Os achados LOW convergem para uma melhoria estrutural única: unificar `DuplicateRequestError` sob `DomainError`.
