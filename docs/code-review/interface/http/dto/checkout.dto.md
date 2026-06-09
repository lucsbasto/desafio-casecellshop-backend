# Code Review — src/interface/http/dto/checkout.dto.ts

## Resumo

DTOs de entrada/saída do `POST /checkout`, bem construídos: charset limitado no `productId`
(que vira chave Redis), limites numéricos sãos, fan-out limitado em `items` e validação
declarativa via `class-validator`. O arquivo está sólido. Os achados mais relevantes não estão
no que o DTO faz, e sim no que ele **não cobre**: o header `Idempotency-Key` não tem DTO/validação
e há redundância/inconsistência menor entre decorators.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0 |
| HIGH       | 0 |
| MEDIUM     | 2 |
| LOW        | 3 |

---

## MEDIUM

### M1 — `Idempotency-Key` não é validado e flui sem limites para chaves Redis
- **Local:** arquivo todo (lacuna). Consumo em `checkout.controller.ts:38` e
  `checkout.usecase.ts:77,88` (`idempotency.remember(key, ...)`).
- **Descrição:** o `productId` recebe `@MaxLength(64)` e `@Matches(/^[A-Za-z0-9_-]+$/)`
  justamente porque "flows straight into Redis keys" (comentário linha 22). Porém o
  `Idempotency-Key`, que tem exatamente o mesmo destino (`remember(key, ...)` → chave Redis de
  idempotência), chega como header bruto, sem nenhum DTO, sem limite de tamanho e sem charset.
  Um cliente pode enviar uma chave de megabytes ou com caracteres de controle/`\n`/`:` que
  poluem o keyspace do Redis.
- **Impacto:** inconsistência de postura de segurança/robustez: a defesa aplicada ao `productId`
  é contornável pelo header. Risco de memory amplification no Redis e de colisão/poluição de
  namespace de chaves. É a contrapartida natural deste DTO e merece o mesmo rigor.
- **Correção sugerida:** validar o header. Como NestJS não roda `class-validator` em
  `@Headers()` por padrão, validar no use case ou via pipe dedicado. Ex. no controller:
  ```ts
  @Headers('idempotency-key') idempotencyKey?: string,
  // ...
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
    throw new BadRequestException('Idempotency-Key inválida');
  }
  ```
  Ou expor um `IdempotencyKeyDto`/pipe reutilizável. Documentar o limite no `@ApiHeader`.

### M2 — `items` permite `productId` duplicado na mesma requisição
- **Local:** `CheckoutRequestDto.items` (linhas 34-43).
- **Descrição:** nada impede `[{productId:'A',quantity:2},{productId:'A',quantity:3}]`. O use case
  (`checkout.usecase.ts:103-118`) itera item a item, então o mesmo produto sofre duas reservas
  separadas (2 + 3) e o `totalCents` soma duas vezes. Pode ser intencional, mas raramente é o
  comportamento desejado de um carrinho e abre espaço para inflar o fan-out efetivo apesar do
  `@ArrayMaxSize(50)`.
- **Impacto:** semântica ambígua de carrinho; duas reservas/spans/linhas de pedido para o mesmo
  SKU; o limite de 50 itens não equivale a 50 produtos distintos.
- **Correção sugerida:** decidir a política e torná-la explícita. Se duplicatas não são
  permitidas, adicionar um validador customizado (`@ArrayUnique(i => i.productId)` do
  class-validator) ou consolidar quantidades por `productId` antes da reserva no use case.

---

## LOW

### L1 — Decorators numéricos redundantes em `quantity`
- **Local:** linhas 27-30.
- **Descrição:** `@IsPositive()` e `@Min(1)` são redundantes para inteiros (`@IsInt` + `@Min(1)`
  já garante ≥ 1; `@IsPositive` por si garante > 0). Três decorators de limite inferior fazem o
  mesmo trabalho e geram mensagens de erro duplicadas no 400.
- **Impacto:** ruído de manutenção e mensagens de validação repetidas no corpo do erro.
- **Correção sugerida:** manter `@IsInt() @Min(1) @Max(1000)` e remover `@IsPositive()`.

### L2 — `@ApiProperty` de saída sem `required`/tipos explícitos pode divergir do contrato
- **Local:** `CheckoutAcceptedDto` (linhas 45-57).
- **Descrição:** campos `readonly` com `!` ficam corretos em runtime, mas o Swagger infere tipo a
  partir do TS; `orderId` não declara `type`/`format: 'uuid'` apesar de ser UUID
  (`randomUUID()` no use case). É documentação, não correção, mas o contrato OpenAPI fica menos
  preciso.
- **Impacto:** consumidores do `openapi.json` não sabem que `orderId` é UUID; cosmético.
- **Correção sugerida:** `@ApiProperty({ format: 'uuid', example: 'a1b2c3d4-...' })` em `orderId`.

### L3 — Mensagem de erro do `productId` em PT-BR sem i18n; demais validators em EN/default
- **Local:** linha 23 (`message: 'productId deve conter apenas [A-Za-z0-9_-]'`).
- **Descrição:** só este validator tem mensagem customizada em português; os demais usam as
  default (inglês). Mistura de idiomas no corpo de erro 400.
- **Impacto:** inconsistência de UX na API; cosmético.
- **Correção sugerida:** padronizar (todas customizadas em PT, ou deixar todas default), ou
  centralizar mensagens.

---

## Pontos positivos

- **Charset/length cap no `productId`** com justificativa explícita (linha 22): defesa correta e
  bem documentada contra injeção em keyspace Redis.
- **Limites numéricos defensivos** em `quantity` (`@Max(1000)`) e no array (`@ArrayMinSize(1)` +
  `@ArrayMaxSize(50)`) com comentário explicando o controle de fan-out — exatamente o tipo de
  raciocínio de capacidade que se espera num checkout.
- **`@ValidateNested({ each: true })` + `@Type(() => CheckoutItemDto)`** corretos, pré-requisito
  para a validação aninhada funcionar sob `transform: true`.
- **Aderência hexagonal:** o DTO vive na borda HTTP e o controller mapeia para tipos de domínio
  (`OrderItem`); nenhum vazamento de infra. O reuso de `OrderStatus` do domínio no
  `CheckoutAcceptedDto` é aceitável (enum puro, sem dependência de infra).
- **`ValidationPipe` global** com `whitelist + forbidNonWhitelisted + transform`
  (`main.ts:18-20`) fecha o flanco de propriedades extras, complementando bem este DTO.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo em si é de boa qualidade e idiomático. As ressalvas são: (M1) a validação do
`Idempotency-Key` está ausente e é a contrapartida natural da defesa já aplicada ao `productId` —
deveria receber o mesmo tratamento de length/charset antes de virar chave Redis; e (M2) a política
de `productId` duplicado deve ser decidida explicitamente. Os achados LOW são limpeza cosmética.
Nenhum bloqueia merge, mas M1 deveria ser endereçado em seguida por consistência de segurança.
