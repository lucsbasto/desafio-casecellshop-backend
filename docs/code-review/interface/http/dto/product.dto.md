# Code Review — src/interface/http/dto/product.dto.ts

## Resumo

`ProductDto` é um DTO de **resposta** (saída), usado apenas para documentação Swagger/OpenAPI nos endpoints `GET /products` e `GET /products/:id`. É uma classe declarativa simples, sem lógica, sem vazamento de infraestrutura e sem decorators de validação (correto para um DTO de saída). Os achados são todos de baixa severidade: duplicação estrutural com o tipo de domínio `ProductView` (risco de drift), exposição de `stock` ao cliente e metadados de schema incompletos.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 0          |
| LOW        | 4          |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

Nenhum achado.

---

## LOW

### L1 — Duplicação estrutural com `ProductView` (risco de drift de schema)

- **Local:** linhas 3–18 (classe inteira); comparar com `src/domain/product.ts:14-20` (`ProductView`).
- **Descrição:** `ProductDto` repete campo a campo a forma de `ProductView` (`id`, `name`, `priceCents`, `available`, `stock`). O `ListProductsUseCase` retorna `ProductView`, mas o controller (`products.controller.ts:14,21`) declara o retorno como `ProductDto`/`ProductDto[]` e devolve o `ProductView` diretamente, sem mapeamento explícito. Não há checagem em tempo de compilação garantindo que as duas formas permaneçam idênticas: se `ProductView` ganhar/perder um campo, o `ProductDto` (e, portanto, o contrato OpenAPI) divergem silenciosamente do que é realmente serializado.
- **Impacto:** Manutenibilidade e fidelidade da documentação. O `@ApiOkResponse({ type: ProductDto })` pode passar a mentir sobre o payload real sem nenhum erro de build. Como o objeto serializado é o `ProductView` (não uma instância de `ProductDto`), qualquer campo extra do domínio "vaza" pela serialização mesmo sem estar no DTO.
- **Correção sugerida:** Amarrar o DTO ao tipo de domínio em tempo de compilação para que o drift quebre o build. Ex.:

  ```ts
  import type { ProductView } from '../../../domain/product';

  export class ProductDto implements ProductView {
    @ApiProperty({ example: 'CAPA-001' })
    id!: string;
    // ... demais campos
  }
  ```

  Com `implements ProductView`, remover/renomear um campo em `ProductView` gera erro de compilação no DTO. Idealmente, combinar com um ponto único de tradução domínio→DTO no controller/use case (já apontado na review do controller).

### L2 — Exposição de `stock` (quantidade exata) no payload público

- **Local:** linhas 16–17 (`stock`).
- **Descrição:** O DTO público expõe a quantidade exata em estoque. O domínio já oferece `available: boolean` (derivado de `stock > 0` em `toProductView`), que normalmente é o suficiente para a vitrine. Expor o número exato é uma decisão de negócio/segurança: revela giro de inventário e pode habilitar scraping competitivo ou inferência de vendas.
- **Impacto:** Divulgação de informação de negócio. Não é uma vulnerabilidade técnica, mas em e-commerce a quantidade exata costuma ser tratada como dado sensível (ou exposta apenas em faixas, ex.: "últimas unidades").
- **Correção sugerida:** Confirmar com o produto se `stock` deve ser público. Se não, remover o campo do DTO e manter só `available`; se sim por UX ("poucas unidades"), considerar expor uma faixa/flag (`lowStock: boolean`) em vez do número absoluto. Como o controller serializa o `ProductView` cru, lembrar que remover só do DTO **não** impede o vazamento — é preciso garantir o mapeamento explícito (ver L1) ou remover de `ProductView`.

### L3 — Metadados de schema incompletos (formato e nullability)

- **Local:** linhas 4–17 (todos os `@ApiProperty`).
- **Descrição:** Os `@ApiProperty` trazem `example`, mas faltam restrições úteis no contrato: `priceCents` e `stock` não declaram `minimum: 0` nem `type: 'integer'`; `id` não declara `pattern`/`format` (os exemplos sugerem SKU tipo `CAPA-001`). Sem isso, o OpenAPI gerado documenta `number` genérico (aceitaria float/negativo na perspectiva do contrato) e não comunica o formato do id.
- **Impacto:** Qualidade da documentação e dos clientes gerados a partir do OpenAPI. Baixo, pois é DTO de saída (servidor controla os valores), mas consumidores/SDKs gerados ficam menos precisos.
- **Correção sugerida:** Enriquecer os decorators:

  ```ts
  @ApiProperty({ example: 4990, minimum: 0, type: 'integer', description: 'Preço em centavos (evita float)' })
  priceCents!: number;

  @ApiProperty({ example: 25, minimum: 0, type: 'integer' })
  stock!: number;
  ```

### L4 — Campos sem `description` (exceto `priceCents`)

- **Local:** linhas 4–17.
- **Descrição:** Apenas `priceCents` tem `description`. `available` em especial é semanticamente não óbvio: significa `stock > 0`, e não "publicado/ativo no catálogo". Sem descrição, um consumidor pode interpretar errado.
- **Impacto:** Clareza do contrato. Cosmético.
- **Correção sugerida:** Adicionar `description` curta nos campos não triviais, ex.: `@ApiProperty({ example: true, description: 'Derivado de stock > 0' })` em `available`.

---

## Pontos positivos

- DTO de saída corretamente **sem** decorators de validação (`class-validator`) — validação de entrada não se aplica a respostas; não há over-engineering.
- Uso de `priceCents` (inteiro em centavos) evita problemas de ponto flutuante com dinheiro — decisão correta e documentada.
- Zero vazamento de infraestrutura: nenhum import de ORM, Redis, BullMQ ou detalhe de persistência. Aderente à arquitetura hexagonal (camada de interface).
- Separação adequada entre `Product` (domínio interno, com `stock`) e a view pública, com o DTO espelhando a forma de saída esperada.
- Uso de `!` (definite assignment) é apropriado aqui, já que os objetos são produzidos por serialização e não instanciados via construtor.
- Arquivo coeso, pequeno e de responsabilidade única.

---

## Veredito

**Aprovado com ressalvas.** O arquivo é sólido e correto para sua função (DTO de documentação de resposta). Nenhum bug de correção, concorrência ou segurança técnica. As ressalvas são de manutenibilidade/contrato: **L1 (amarrar ao `ProductView` para evitar drift)** é a mais relevante e barata de aplicar; **L2 (exposição de `stock`)** exige uma decisão de produto antes de produção. Os demais (L3/L4) são melhorias cosméticas de documentação OpenAPI e não bloqueiam o merge.
