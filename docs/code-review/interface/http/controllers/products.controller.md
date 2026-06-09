# Code Review — src/interface/http/controllers/products.controller.ts

## Resumo

Controller HTTP fino e bem alinhado à arquitetura hexagonal: delega 100% da lógica ao `ListProductsUseCase` e expõe apenas dois endpoints de leitura (`GET /products` e `GET /products/:id`). Não há bugs de correção, concorrência ou segurança graves no arquivo. Os achados são de baixa severidade: validação ausente do parâmetro `:id`, leve incoerência de tipo de retorno (`ProductView` vs `ProductDto`) e ausência de teste dedicado.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 1         |
| LOW        | 3         |

---

## MEDIUM

### M1 — Parâmetro `:id` sem validação/sanitização explícita
- **Local:** linha 21 — `@Param('id') id: string`
- **Descrição:** O `id` é repassado direto ao caso de uso (`this.listProducts.getById(id)`) sem nenhuma validação de formato, tamanho ou conjunto de caracteres. O `ValidationPipe` global configurado em `main.ts` (`whitelist`, `transform`, `forbidNonWhitelisted`) não atua sobre `@Param` primitivo sem DTO nem sem pipe específico — params soltos do tipo `string` passam intactos. A montagem da chave de cache `products:${id}` (em `list-products.usecase.ts:11`) usa o valor cru.
- **Impacto:**
  - Strings arbitrariamente grandes ou com caracteres de controle viram chave de cache (`products:<lixo>`). Em Redis/cache, isso permite poluição do keyspace e potencial vetor de cache-pollution/DoS de baixo custo (cada `id` distinto cria uma entrada e dispara um single-flight contra o "ERP").
  - Embora não haja injeção SQL aqui (repositório fake), o padrão de confiar em input não validado para compor chaves de infraestrutura é frágil e propaga risco caso o repositório real venha a interpolar o `id`.
- **Correção sugerida:** Restringir o formato no controller. Se os ids forem UUID, usar `ParseUUIDPipe`. Como os exemplos do `ProductDto` mostram ids tipo `CAPA-001` (SKU), aplicar um pipe de validação por regex/tamanho:

```ts
import { BadRequestException, Param, PipeTransform, Injectable } from '@nestjs/common';

@Injectable()
class ProductIdPipe implements PipeTransform<string, string> {
  private static readonly RE = /^[A-Za-z0-9_-]{1,64}$/;
  transform(value: string): string {
    if (!ProductIdPipe.RE.test(value)) {
      throw new BadRequestException('Invalid product id');
    }
    return value;
  }
}

// ...
async findOne(@Param('id', ProductIdPipe) id: string): Promise<ProductDto> {
  return this.listProducts.getById(id);
}
```

---

## LOW

### L1 — Incoerência entre tipo de retorno declarado e o retornado pelo use case
- **Local:** linhas 14-15 e 21-22
- **Descrição:** Os métodos declaram retorno `Promise<ProductDto[]>` / `Promise<ProductDto>`, mas o `ListProductsUseCase` retorna `ProductView` / `ProductView[]` (`list-products.usecase.ts:34,47`). Compila por compatibilidade estrutural (todo campo de `ProductDto` existe em `ProductView`), mas o tipo de domínio (`ProductView`) está vazando como se fosse o DTO de transporte sem conversão explícita. Há duas representações do mesmo dado (`ProductView` no domínio, `ProductDto` na borda HTTP) sem ponto de mapeamento, então uma divergência futura entre os dois (ex.: campo novo em `ProductDto` ausente em `ProductView`) só seria detectada por sorte.
- **Impacto:** Manutenibilidade e clareza de contrato. A divergência silenciosa pode produzir respostas sem campos esperados pelo Swagger ou expor campos não documentados. Não é um bug atual.
- **Correção sugerida:** Alinhar os tipos explicitamente. Opção mais limpa: fazer o use case retornar o tipo de domínio e o controller declarar/mapear para `ProductDto` de forma explícita (mesmo que trivial), ou anotar o retorno do controller como o tipo de domínio e documentar o DTO apenas via Swagger. O importante é ter um único ponto de tradução domínio→DTO.

### L2 — Ausência de teste dedicado ao controller
- **Local:** arquivo inteiro (nenhum `products.controller.spec.ts` encontrado)
- **Descrição:** Não existe teste unitário/e2e cobrindo este controller. Mesmo sendo um pass-through, o roteamento, o decorator de path param e o contrato Swagger não têm verificação automatizada.
- **Impacto:** Regressões de roteamento ou de contrato passam despercebidas. Baixo risco por ser thin controller, mas a borda HTTP é justamente onde o contrato público é firmado.
- **Correção sugerida:** Adicionar um spec mockando `ListProductsUseCase` que verifique: (a) `findAll` delega a `listAll`; (b) `findOne` repassa o `id` recebido a `getById`; (c) propagação de `ProductNotFoundError` mapeada para 404. Idealmente um teste e2e leve confirmando o status 404 via filtro de exceção.

### L3 — `:id` colide com a rota de coleção e não há tratamento de path encoding
- **Local:** linhas 18-23
- **Descrição:** A rota `@Get(':id')` captura qualquer segmento, incluindo valores percent-encoded. O `id` chega já decodificado pelo router; combinado com a falta de validação (M1), valores como `products/%2e%2e` ou espaços ficam normalizados de formas que o operador pode não esperar ao depurar chaves de cache. Não é uma vulnerabilidade direta aqui (sem acesso a filesystem/SQL), mas reforça a necessidade de M1.
- **Impacto:** Observabilidade/depuração e consistência de chave de cache. Severidade baixa, dependente de M1.
- **Correção sugerida:** Resolver via o pipe de M1 (valida e rejeita o que não casar com o formato esperado), eliminando ambiguidade de encoding antes de chegar ao use case.

---

## Pontos positivos

- **Aderência hexagonal exemplar:** o controller só conhece o `ListProductsUseCase` (camada de aplicação). Zero acoplamento com cache, repositório, Redis ou ERP. Não há vazamento de infraestrutura na borda.
- **Idiomatismo NestJS correto:** DI via construtor, `readonly`, decorators de rota e Swagger (`@ApiOkResponse`, `@ApiNotFoundResponse`, `@ApiTags`) bem aplicados. Escopo default (singleton) é o adequado para um controller stateless.
- **Sem estado mutável, sem race conditions:** controller puramente stateless; toda a complexidade de cache-aside/single-flight/stale-on-error está corretamente isolada no use case e na `CachePort`.
- **Tratamento de erro delegado e limpo:** o 404 vem de `ProductNotFoundError` lançado no use case e mapeado por filtro de exceção; o controller não engole erros nem mascara stack traces.
- **Documentação de contrato presente:** respostas de sucesso e de não-encontrado tipadas no Swagger, o que torna o contrato público explícito.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é sólido, idiomático e arquiteturalmente correto. A única ressalva relevante é **M1 (validação do `:id`)**, recomendada antes de produção para fechar o vetor de poluição de keyspace de cache. Os achados LOW (alinhamento de tipos `ProductView`/`ProductDto`, teste dedicado e tratamento de encoding) são melhorias de manutenibilidade/robustez e não bloqueiam o merge.
