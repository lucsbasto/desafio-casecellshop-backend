# Code Review — src/application/use-cases/get-order-status.usecase.ts

## Resumo

Use case de leitura (query) extremamente simples e bem desenhado: recupera um pedido por ID via porta de repositório e lança erro de domínio quando ausente. Adere corretamente à arquitetura hexagonal (depende só da porta, sem vazamento de infra) e ao idiomatismo NestJS (DI por token Symbol). Não há defeitos de correção, concorrência ou segurança no arquivo. As ressalvas são menores e majoritariamente de cobertura de teste e validação de entrada (que hoje vive na borda).

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 0 |
| MEDIUM     | 0 |
| LOW        | 3 |

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

### LOW-1 — Ausência de teste dedicado, incluindo o caminho de "não encontrado"

- **Local:** arquivo inteiro (linhas 10-14); não há `get-order-status.usecase.spec.ts`.
- **Descrição:** O use case só é exercitado indiretamente em `checkout-flow.spec.ts` (linhas 80 e 132), sempre no caminho feliz onde o pedido existe. O ramo `if (!order) throw new OrderNotFoundError(orderId)` (linha 12) — a única lógica de fato do arquivo — não tem cobertura comportamental.
- **Impacto:** Uma regressão que removesse o guard (ex.: retornar `order` direto) passaria nos testes atuais. O contrato "404 quando inexistente", que é o principal valor deste use case, fica desprotegido.
- **Correção sugerida:** Adicionar um spec mínimo com um fake/stub da porta:

```ts
describe('GetOrderStatusUseCase', () => {
  it('retorna o pedido quando existe', async () => {
    const order = { id: 'o1' } as Order;
    const repo = { findById: jest.fn().mockResolvedValue(order) } as Partial<OrderRepositoryPort>;
    const uc = new GetOrderStatusUseCase(repo as OrderRepositoryPort);
    await expect(uc.execute('o1')).resolves.toBe(order);
  });

  it('lança OrderNotFoundError quando não existe', async () => {
    const repo = { findById: jest.fn().mockResolvedValue(undefined) } as Partial<OrderRepositoryPort>;
    const uc = new GetOrderStatusUseCase(repo as OrderRepositoryPort);
    await expect(uc.execute('missing')).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});
```

### LOW-2 — `orderId` não é validado/normalizado em nenhuma camada

- **Local:** linha 10 (assinatura `execute(orderId: string)`); origem em `orders.controller.ts:15` (`@Param('orderId') orderId: string`).
- **Descrição:** O `orderId` chega cru do path param até `findById`, sem validação de formato (UUID, comprimento máximo) nem trim. O controller não aplica `ParseUUIDPipe` nem DTO. Embora o repositório atual (in-memory/read model) provavelmente apenas faça lookup por chave — o que torna injeção improvável aqui —, uma string vazia, gigante ou com caracteres inesperados é repassada sem barreira.
- **Impacto:** Baixo no contexto atual (lookup por igualdade de chave não é vulnerável a injeção). Porém, se a porta vier a ser implementada sobre um datastore que interpola o ID (SQL/NoSQL/Redis key building), a falta de validação na borda vira superfície de risco. Também permite chamadas com IDs claramente inválidos chegarem à camada de aplicação consumindo trabalho desnecessário.
- **Correção sugerida:** Validar na borda (preferível, mantém o domínio limpo) — no controller usar `@Param('orderId', new ParseUUIDPipe())` se os IDs forem UUID, ou um DTO/pipe de validação de formato. Se IDs não forem UUID, ao menos impor limite de comprimento. Não é necessário poluir o use case com isso; a borda é o lugar idiomático no NestJS.

### LOW-3 — Retorno expõe a entidade de domínio completa (acoplamento de contrato)

- **Local:** linha 13 (`return order;`), tipo de retorno `Promise<Order>` (linha 10).
- **Descrição:** O use case devolve o agregado `Order` inteiro, incluindo campos internos como `idempotencyKey`. Hoje o `OrdersController` (linhas 17-26) já faz o mapeamento para `OrderStatusDto` e **não** propaga `idempotencyKey`, então não há vazamento de dado sensível pela API atualmente. O ponto é de design/manutenção: o use case não controla o que é exposto; qualquer novo consumidor recebe o agregado cru e pode vazar `idempotencyKey` por engano.
- **Impacto:** Manutenibilidade e robustez do contrato. `idempotencyKey` é um detalhe interno que não deveria ser trivialmente exponível; a proteção depende inteiramente da disciplina de cada caller fazer o mapeamento manualmente.
- **Correção sugerida:** Opção pragmática — manter o retorno de `Order` (use case de query é legítimo retornar o agregado) e documentar/centralizar a serialização. Opção mais estrita — retornar um tipo de leitura (read model/projection) sem `idempotencyKey`, garantindo por construção que o segredo de idempotência não escape do use case. Dado o tamanho do projeto, a primeira é aceitável; registre a decisão.

---

## Pontos positivos

- **Arquitetura hexagonal correta:** depende apenas de `OrderRepositoryPort` via token `ORDER_REPO_PORT` (Symbol), sem nenhum acoplamento a infraestrutura. Direção de dependência impecável (aplicação → porta).
- **Erro de domínio adequado:** lança `OrderNotFoundError` (subtipo de `DomainError` com `code`), deixando a tradução para HTTP 404 a cargo do exception filter na borda — domínio independente de HTTP.
- **Correção e edge cases:** o único edge case relevante (pedido inexistente) é tratado explicitamente; a checagem `!order` cobre corretamente `undefined` retornado pela porta. Não há `await` em loop, alocações desnecessárias, mutação ou estado compartilhado.
- **Sem concorrência/atomicidade a considerar:** operação puramente de leitura, idempotente, sem efeitos colaterais — não há race conditions.
- **Tipos sólidos:** sem `any`, sem asserções de tipo inseguras, sem catch silencioso. `readonly` na dependência injetada. Complexidade ciclomática trivial.
- **Idiomatismo NestJS:** `@Injectable()` + `@Inject(token)` corretos; provider com escopo singleton (default) apropriado para um use case stateless.

---

## Veredito

**Aprovado.**

O arquivo está sólido e correto para sua responsabilidade. Nenhum achado de severidade CRITICAL/HIGH/MEDIUM. As três ressalvas LOW são melhorias incrementais (cobertura de teste do ramo de erro, validação de `orderId` na borda e endurecimento do contrato de saída) e não bloqueiam o merge. Recomenda-se priorizar o LOW-1 (teste do caminho `OrderNotFoundError`) por ser baixo custo e proteger o comportamento central do use case.
