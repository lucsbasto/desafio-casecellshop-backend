# Code Review — src/interface/http/dto/order.dto.ts

## Resumo

O arquivo define três DTOs de **resposta** (`OrderTransitionDto`, `OrderItemDto`, `OrderStatusDto`) usados exclusivamente para serialização de saída no endpoint `GET /orders/:orderId/status` e para documentação Swagger. Não há entrada de usuário aqui (os DTOs de request ficam em `checkout.dto.ts`), então a superfície de risco é pequena. O código é simples, idiomático e correto. As ressalvas são de manutenibilidade/contrato: ausência de uma camada de mapeamento explícita (o controller monta o objeto à mão) e leve divergência de tipos com o domínio.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 1         |
| LOW        | 4         |

---

## MEDIUM

### M1 — DTO de resposta sem mapeamento explícito; risco de vazamento de campos do domínio
- **Local:** todo o arquivo (linhas 23-47) em conjunto com `orders.controller.ts:17-26`
- **Descrição:** `OrderStatusDto` é apenas uma *forma* declarativa para o Swagger. A serialização real é feita por montagem manual no controller, sem `class-transformer`/`@Exclude`/`ClassSerializerInterceptor`. O objeto `Order` do domínio contém `idempotencyKey` (`domain/order.ts:30`), um campo sensível que **não** deve ir para o cliente. Hoje o controller protege isso por construir o objeto campo a campo — mas essa proteção é frágil: basta alguém trocar o corpo do método por `return order;` ou `return { ...order, ... }` para vazar `idempotencyKey`. O DTO, por ser só uma classe de marcação sem `@Exclude`/whitelist em runtime, não oferece nenhuma barreira.
- **Impacto:** Exposição potencial de dados sensíveis (`idempotencyKey`) se o mapeamento manual regredir. Como o tipo de retorno declarado é `Promise<OrderStatusDto>`, o TypeScript **não** acusaria `return { ...order }` como erro (excesso de propriedades só é checado em literais diretos, não em spreads), então a regressão passa pela compilação silenciosamente.
- **Correção sugerida:** Adotar serialização baseada em allow-list para garantir o contrato em runtime. Ex.: anotar o DTO com `@Expose()` nos campos publicados e `@Exclude()` na classe, habilitar `ClassSerializerInterceptor` (com `excludeExtraneousValues: true`) e retornar `plainToInstance(OrderStatusDto, order)`. Alternativamente, manter o mapeamento manual mas centralizá-lo num mapper testado (`toOrderStatusDto(order)`) e cobri-lo com um teste que afirme explicitamente a ausência de `idempotencyKey` na saída.

```ts
// mapper dedicado e testável
export function toOrderStatusDto(o: Order): OrderStatusDto {
  return {
    id: o.id,
    status: o.status,
    items: o.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    totalCents: o.totalCents,
    history: o.history.map((h) => ({ status: h.status, at: h.at, reason: h.reason })),
    attempts: o.attempts,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
// teste: expect(dto).not.toHaveProperty('idempotencyKey');
```

---

## LOW

### L1 — Reaproveitamento de referências do domínio na serialização (aliasing)
- **Local:** `orders.controller.ts:20,22` ao popular `items` e `history` do `OrderStatusDto`
- **Descrição:** Embora seja sobre o uso do DTO, vale registrar no contrato: o controller atribui `order.items` e `order.history` por referência. Os arrays e seus objetos são os mesmos do domínio. Se em algum ponto a serialização passar a mutar o DTO (ex.: ordenar `history` in-place), estará mutando o estado retornado pelo repositório/cache.
- **Impacto:** Risco latente de mutação acidental de estado compartilhado; nenhum bug atual.
- **Correção sugerida:** Mapear os itens com `.map(...)` (vide M1) para produzir cópias rasas dos elementos publicados, desacoplando o DTO do agregado.

### L2 — `at` tipado como `string` solta, sem contrato de formato no DTO de saída
- **Local:** linha 9 (`readonly at!: string`), linhas 43 e 46 (`createdAt`, `updatedAt`)
- **Descrição:** O domínio documenta `at` como ISO timestamp (`domain/order.ts:21`), mas o DTO só declara `string`. O Swagger não anota `format: 'date-time'`, então o contrato OpenAPI não comunica que o consumidor deve esperar ISO-8601.
- **Impacto:** Documentação de API menos precisa; clientes gerados por codegen tratam como string genérica.
- **Correção sugerida:** `@ApiProperty({ format: 'date-time', example: '2026-06-09T03:00:00.000Z' })` em `at`, `createdAt` e `updatedAt`.

### L3 — `OrderItemDto` não documenta limites; divergência sutil com o DTO de entrada
- **Local:** linhas 15-21
- **Descrição:** O `CheckoutItemDto` de entrada documenta `maxLength: 64`, `pattern` e `minimum/maximum` para `quantity`. O `OrderItemDto` de saída, por ser resposta, não precisa de validação, mas a ausência de qualquer anotação de exemplo coerente (ex.: descrever que `quantity` é inteiro positivo) deixa o contrato de saída menos informativo que o de entrada. É puramente documental.
- **Impacto:** Inconsistência cosmética na documentação OpenAPI.
- **Correção sugerida:** Opcional — alinhar exemplos/descrições com `CheckoutItemDto` para um contrato coeso.

### L4 — Falta de teste do contrato de serialização (incluindo não-vazamento)
- **Local:** arquivo sem teste correspondente (`*.dto.spec.ts` inexistente)
- **Descrição:** Não há teste afirmando o shape exato retornado nem a ausência de `idempotencyKey`. Combinado com M1, isso significa que uma regressão de vazamento não seria detectada automaticamente.
- **Impacto:** Cobertura comportamental ausente sobre o contrato público da API.
- **Correção sugerida:** Adicionar teste (no nível do controller/mapper) que verifique campos presentes e `not.toHaveProperty('idempotencyKey')`.

---

## Pontos positivos
- DTOs imutáveis (`readonly`) e bem separados por responsabilidade — boa higiene.
- Uso correto de `@ApiProperty({ enum: OrderStatus })` para enums e `type: [Dto]` para arrays aninhados, gerando OpenAPI preciso para esses campos.
- Zero `any`, zero asserções de tipo inseguras, zero lógica — DTOs são puramente declarativos, como deve ser na camada de interface (aderência à arquitetura hexagonal: a interface não vaza infra nem regra de domínio).
- `OrderStatusDto.status` reusa o enum de domínio em vez de duplicar literais, mantendo uma única fonte de verdade para a máquina de estados.
- O campo sensível `idempotencyKey` foi corretamente **omitido** do DTO de saída — a intenção de contrato está certa; a ressalva M1 é apenas sobre torná-la à prova de regressão em runtime.

---

## Veredito
**Aprovado com ressalvas.**

O arquivo está correto e idiomático para sua função (DTOs de resposta + documentação). Não há bugs, problemas de concorrência ou de segurança intrínsecos ao arquivo. A ressalva relevante (M1) é de robustez de contrato: garantir, em runtime e com teste, que campos sensíveis do agregado (`idempotencyKey`) nunca vazem, já que a proteção atual depende inteiramente do mapeamento manual no controller. As demais são cosméticas/documentais.
