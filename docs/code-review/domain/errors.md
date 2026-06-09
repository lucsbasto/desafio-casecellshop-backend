# Code Review — src/domain/errors.ts

## Resumo

Arquivo pequeno e bem desenhado: define uma hierarquia de erros de domínio (`DomainError` + subclasses) com `code` estável, mantendo o domínio agnóstico de HTTP (a tradução para status vive no `DomainExceptionFilter`). O código está correto e idiomático para o `target: ES2021` do projeto. Os achados são de consistência arquitetural, type safety e ausência de teste — nenhum bug crítico.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 0 |
| MEDIUM     | 2 |
| LOW        | 4 |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

### M1 — `code` é `string` livre, sem união de literais (type safety fraca e contrato exposto ao cliente)

- **Local:** linha 8 (`readonly code: string`) e linhas 18, 25, 32, 39.
- **Descrição:** `code` é tipado como `string`. Esse valor é o contrato semântico do erro e é serializado diretamente no corpo da resposta HTTP pelo filtro (`domain-exception.filter.ts:62`, `error = (exception as DomainError).code`). Como é `string` livre, nada impede um typo (`'INSUFICIENT_STOCK'`), duplicação ou divergência silenciosa entre código e consumidores. Não há fonte única de verdade dos códigos.
- **Impacto:** Um erro de digitação em `code` não é detectado pelo compilador, mas vira um contrato de API quebrado para o cliente (que tipicamente faz `switch (error)` para tratar 409 de estoque vs. 404). Também dificulta gerar documentação/OpenAPI dos códigos possíveis.
- **Correção sugerida:** Centralizar os códigos em uma união de literais e tipar `code` com ela:

```ts
export const ERROR_CODES = {
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  INVALID_ORDER_TRANSITION: 'INVALID_ORDER_TRANSITION',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
```

### M2 — `DuplicateRequestError` não estende `DomainError` (hierarquia de domínio não reaproveitada)

- **Local:** linha 5 (definição de `DomainError`); consumidor em `src/application/use-cases/checkout.usecase.ts:31-36`.
- **Descrição:** `DuplicateRequestError` é um erro de domínio (regra de idempotência), porém é declarado em `checkout.usecase.ts` como `extends Error` e redefine `readonly code = 'DUPLICATE_REQUEST'` manualmente, em vez de estender `DomainError`. Como consequência, o filtro precisa de um caminho especial em vários pontos (`statusFor`: `err instanceof DuplicateRequestError`; `catch`: `exception instanceof DomainError || exception instanceof DuplicateRequestError`; e o cast `(exception as DomainError).code`). O `errors.ts` deixou de ser a fonte única da hierarquia de erros de domínio.
- **Impacto:** Toda vez que surgir um novo erro de domínio fora dessa hierarquia, o filtro acumula ramos especiais e casts — exatamente a duplicação que o tipo base `DomainError` existe para evitar. Aumenta o risco de um erro futuro cair no fallback 500 por esquecimento de adicionar o `instanceof` extra.
- **Correção sugerida:** Mover `DuplicateRequestError` para `errors.ts` e fazê-lo estender `DomainError`, eliminando os ramos especiais do filtro:

```ts
/** Requisição duplicada cuja tentativa original ainda não concluiu. -> HTTP 409 */
export class DuplicateRequestError extends DomainError {
  constructor() {
    super('Requisição duplicada cuja tentativa original não foi concluída', 'DUPLICATE_REQUEST');
  }
}
```

Com isso o filtro reduz a `exception instanceof DomainError` e `exception.code` sem cast.

---

## LOW

### L1 — Ausência de teste dedicado (`errors.spec.ts` não existe)

- **Local:** arquivo inteiro.
- **Descrição:** Não há `src/domain/errors.spec.ts`. O comportamento desta classe é *load-bearing* para o filtro HTTP: ele depende de `instanceof DomainError`, de `err.code` e do `name` da subclasse. Nenhum teste blinda esse contrato.
- **Impacto:** Uma regressão sutil (ex.: alguém remover `this.name = new.target.name`, ou trocar o `code` de uma subclasse) passa despercebida até quebrar a resposta de API em produção.
- **Correção sugerida:** Adicionar teste cobrindo, para cada subclasse: `instanceof DomainError === true`, `err.name === 'InsufficientStockError'` (etc.), `err.code` esperado e que a `message` interpola o id corretamente.

```ts
it('preserva name, code e instanceof', () => {
  const e = new InsufficientStockError('p1');
  expect(e).toBeInstanceOf(DomainError);
  expect(e.name).toBe('InsufficientStockError');
  expect(e.code).toBe('INSUFFICIENT_STOCK');
  expect(e.message).toContain('p1');
});
```

### L2 — Sem propagação de `cause` (perda potencial de causa raiz)

- **Local:** linhas 6-12 (construtor de `DomainError`).
- **Descrição:** O construtor não aceita nem repassa `options?: { cause?: unknown }` para `super`. Para os erros atuais (originados em regras puras de domínio) isso é aceitável, mas se um erro de domínio passar a embrulhar uma falha de infra (ex.: violação de constraint do repositório traduzida para `InsufficientStockError`), a causa original se perde.
- **Impacto:** Diagnóstico mais difícil quando um erro de domínio é derivado de outra exceção; o stack/`cause` original não chega ao log.
- **Correção sugerida:** Aceitar `ErrorOptions` opcional e repassar: `constructor(message: string, readonly code: ErrorCode, options?: ErrorOptions) { super(message, options); ... }` (suportado nativamente em ES2021).

### L3 — `instanceof` depende do `target` do compilador (defesa de portabilidade)

- **Local:** classe `DomainError` (linha 5) e subclasses.
- **Descrição:** Como `tsconfig` usa `target: ES2021`, a cadeia de protótipo de `extends Error` é preservada e `instanceof DomainError` funciona — **não há bug hoje**. Registro apenas como nota de robustez: se o `target` for rebaixado para ES5 no futuro, todo o roteamento do `DomainExceptionFilter` (que é 100% baseado em `instanceof`) quebraria silenciosamente, caindo tudo em 500.
- **Impacto:** Baixo/condicional — só se materializa numa mudança de build config.
- **Correção sugerida:** Opcionalmente blindar com `Object.setPrototypeOf(this, new.target.prototype)` no construtor de `DomainError`, ou documentar a dependência do `target >= ES2015` próximo às classes.

### L4 — Mensagens de erro em pt-BR acopladas ao domínio, sem chave de i18n

- **Local:** linhas 18, 25, 32, 39.
- **Descrição:** As mensagens humanas estão hardcoded em português dentro do domínio. O `code` (estável, máquina) já está bem separado da `message` (humana), o que é correto; o ponto é apenas que a `message` não é localizável.
- **Impacto:** Muito baixo no escopo atual (um único idioma). Relevante apenas se o produto precisar de i18n nas respostas de erro — nesse caso o cliente deve traduzir a partir do `code`, não da `message`.
- **Correção sugerida:** Manter; documentar que o contrato de tradução do cliente deve usar `code` e tratar `message` como texto de diagnóstico/conveniência. Nenhuma mudança imediata necessária.

---

## Pontos positivos

- **Separação de camadas correta:** o domínio não conhece HTTP; a tradução para status code vive no `DomainExceptionFilter`. Aderência exemplar à arquitetura hexagonal.
- **`this.name = new.target.name`** (linha 11): forma idiomática e correta de preservar o nome da subclasse concreta, em vez de fixar `'DomainError'`. Funciona via herança sem repetição.
- **`code` separado de `message`:** distingue corretamente o identificador estável de máquina do texto humano — exatamente o que um cliente de API precisa para tratamento programático.
- **`readonly code`:** imutabilidade do contrato semântico.
- **Cada subclasse documenta o mapeamento HTTP esperado** no comentário (`-> HTTP 409` etc.), facilitando manter o filtro em sincronia.
- **Construtores fortemente tipados** por entidade (`productId`, `orderId`, `from`/`to`), evitando erros mal-formados na origem.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto e seguro para o `target` atual; não há bug funcional. As ressalvas são de consistência e robustez: (M2) trazer `DuplicateRequestError` para esta hierarquia e (M1) tipar `code` como união de literais — ambos eliminam casts/ramos especiais no filtro e reforçam o contrato de API. Recomenda-se também adicionar o teste dedicado (L1). Nenhum dos achados bloqueia merge.
