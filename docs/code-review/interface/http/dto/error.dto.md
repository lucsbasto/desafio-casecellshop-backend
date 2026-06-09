# Code Review — src/interface/http/dto/error.dto.ts

## Resumo

`ErrorDto` é um DTO de documentação OpenAPI (Swagger) que descreve o schema
padronizado de erro retornado pela API. É uma classe puramente declarativa,
sem lógica, e seu shape corresponde exatamente ao payload produzido por
`DomainExceptionFilter` (`statusCode`, `error`, `message`, `correlationId`,
`timestamp`). O arquivo é sólido; os achados são todos de baixa severidade
(consistência de documentação e robustez de tipos), sem impacto funcional.

| Severidade | Quantidade |
|------------|-----------:|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 0          |
| LOW        | 3          |

---

## CRITICAL

Nenhum achado.

## HIGH

Nenhum achado.

## MEDIUM

Nenhum achado.

## LOW

### LOW-1 — `timestamp` tipado como `string` sem garantia de formato

- **Local:** linhas 17-18 (`timestamp!: string;`)
- **Descrição:** O campo é um `string` livre. O produtor (`domain-exception.filter.ts:82`)
  sempre gera `new Date().toISOString()` (ISO 8601 UTC), mas o tipo não documenta nem
  reforça esse contrato. O `@ApiProperty` poderia declarar `format: 'date-time'` para que
  ferramentas/clientes gerados a partir do OpenAPI tratem o campo como data.
- **Impacto:** Cosmético/documental. Consumidores do contrato OpenAPI não sabem que o
  valor é uma data ISO; geradores de cliente não produzem tipos de data.
- **Correção sugerida:**
  ```ts
  @ApiProperty({
    format: 'date-time',
    example: '2026-06-09T03:00:00.000Z',
  })
  timestamp!: string;
  ```

### LOW-2 — Falta de descrição e enum em `statusCode`/`error`

- **Local:** linhas 5-9 (`statusCode`, `error`)
- **Descrição:** Os campos só têm `example`. O `error` é, na prática, um código simbólico
  estável (`INSUFFICIENT_STOCK`, `INTERNAL_ERROR`, `code` do `DomainError`, etc.) usado por
  clientes para discriminar o tipo de falha programaticamente. Sem `description` (e, idealmente,
  um conjunto/enum documentado dos códigos possíveis), o contrato fica ambíguo: o consumidor não
  sabe se deve fazer match em `error` ou em `statusCode`.
- **Impacto:** Documental. Reduz a clareza do contrato público da API; aumenta a chance de
  clientes acoplarem em `message` (texto livre, em PT-BR) em vez do código estável `error`.
- **Correção sugerida:** Adicionar `description` aos campos e, se a lista de códigos for
  fechada, expô-la (por exemplo via `enum` ou ao menos enumerá-la na descrição):
  ```ts
  @ApiProperty({
    description: 'Código simbólico estável da falha, para discriminação programática.',
    example: 'INSUFFICIENT_STOCK',
  })
  error!: string;
  ```

### LOW-3 — `correlationId` pode assumir valores sentinela não documentados

- **Local:** linhas 14-15 (`correlationId`)
- **Descrição:** O exemplo (`'b7e2...-correlation-id'`) sugere sempre um UUID/ID válido, mas o
  filtro usa o fallback `getCorrelationId() ?? 'unknown'` (`domain-exception.filter.ts:43`).
  Logo, o valor real pode ser literalmente `'unknown'`. O DTO/exemplo não comunica esse caso de
  borda ao consumidor do contrato.
- **Impacto:** Documental. Um cliente que assuma um formato fixo (ex.: validar como UUID) pode
  quebrar ao receber `'unknown'`.
- **Correção sugerida:** Documentar o sentinela na descrição do campo:
  ```ts
  @ApiProperty({
    description:
      'Correlation ID da requisição. Pode ser "unknown" se nenhum ID estiver presente no contexto.',
    example: 'b7e2...-correlation-id',
  })
  correlationId!: string;
  ```

---

## Pontos positivos

- **Shape fiel ao produtor.** Os cinco campos (`statusCode`, `error`, `message`,
  `correlationId`, `timestamp`) batem exatamente com o objeto construído em
  `DomainExceptionFilter.catch` (`domain-exception.filter.ts:77-83`). Não há divergência de
  contrato entre DTO documentado e resposta real.
- **Aderência à arquitetura hexagonal.** O DTO vive corretamente na camada de interface
  (`interface/http/dto`), não vaza nada de domínio e não importa infraestrutura. É apenas um
  contrato de borda HTTP/Swagger — exatamente onde deve estar.
- **Idiomático NestJS/Swagger.** Uso correto de `@ApiProperty` com `example`, e do operador
  de asserção definida (`!`) apropriado para DTOs de documentação que não são instanciados via
  `new` com validação. Sem `any`, sem asserções de tipo inseguras, sem lógica que possa falhar.
- **Padronização de erro centralizada.** Ter um único DTO de erro reutilizado por todos os
  controllers é uma boa prática de consistência do contrato público.

---

## Veredito

**Aprovado.**

O arquivo é um DTO declarativo correto, seguro e bem posicionado na arquitetura. Não há
problemas de correção, concorrência, segurança ou tratamento de erros — o arquivo não contém
lógica executável. Os três achados LOW são melhorias de qualidade da documentação OpenAPI
(formato de data, descrições/enum de códigos e documentação do sentinela `'unknown'`) e podem
ser endereçados oportunisticamente, sem bloquear merge.
