# Code Review — src/interface/http/controllers/orders.controller.ts

## Resumo

O controller é fino, idiomático e bem alinhado à arquitetura hexagonal: delega 100% da lógica ao `GetOrderStatusUseCase` e mapeia o domínio `Order` para o `OrderStatusDto` no adapter de entrada. Não há bugs de correção nem vazamento de infra. As ressalvas são de robustez/manutenibilidade (validação de `orderId`, mapeamento manual duplicado, ausência de teste de 404 dedicado) e nenhuma é bloqueante.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

### M1 — `orderId` não é validado antes de chegar à camada de aplicação/repositório

- **Local:** linha 15 (`@Param('orderId') orderId: string`) e linha 16 (`this.getStatus.execute(orderId)`).
- **Descrição:** o parâmetro de rota é consumido cru, sem `ParseUUIDPipe` nem qualquer validação de formato/tamanho. Qualquer string (inclusive vazia via rota aninhada, ou um valor de centenas de KB) é repassada direto ao use case e dali ao `OrderRepositoryPort.findById`.
- **Impacto:**
  - Defesa em profundidade: dependendo do adapter de persistência (Redis/DB), um `orderId` arbitrário/gigante vira chave de consulta. Em e-commerce com idempotência/estoque é desejável rejeitar entradas malformadas o quanto antes (fail-fast) em vez de transformá-las num `findById` que, no melhor caso, devolve `404` e, no pior, pressiona o storage com chaves não-canônicas.
  - Consistência de contrato: hoje um id inválido e um id inexistente produzem o mesmo `404 ORDER_NOT_FOUND`, escondendo erro de cliente (deveria ser `400`).
- **Correção sugerida:** se os IDs forem UUID (confirmar com o adapter que gera o `order.id`), aplicar `ParseUUIDPipe`; caso o formato seja outro, validar comprimento/charset com um pipe próprio.
  ```ts
  async status(
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ): Promise<OrderStatusDto> {
  ```
  Se o id não for UUID, ao menos `@Param('orderId') orderId: string` com um `ParseStringLengthPipe`/validação de `^[A-Za-z0-9_-]{1,64}$`. (Observação: confirmar o formato real antes de fixar o pipe — não assuma UUID sem evidência.)

### M2 — Mapeamento domínio→DTO manual e propenso a divergência silenciosa

- **Local:** linhas 17–26.
- **Descrição:** o objeto retornado é montado campo a campo a partir do `Order`. O tipo de retorno declarado é `Promise<OrderStatusDto>`, mas como `OrderStatusDto` é uma classe com membros `readonly`/`!` (sem checagem estrutural forte de excesso/falta em objeto literal além do que o TS já faz), a manutenção depende de disciplina humana: ao adicionar um campo no `Order`/DTO, é fácil esquecer de espelhar aqui.
- **Impacto:** risco de regressão silenciosa de contrato de API. Além disso, há acoplamento sutil de tipos: `Order.history` é `OrderTransition[]` (campo `at: string`) e o DTO espera `OrderTransitionDto[]` — funciona por compatibilidade estrutural, mas o mapeamento "passa o array inteiro por referência" sem garantir que apenas os campos públicos do DTO sejam expostos (se o domínio ganhar um campo sensível em `OrderTransition`/`OrderItem`, ele vaza no JSON, pois o objeto serializado é o do domínio).
- **Correção sugerida:** centralizar o mapeamento num mapper/factory (`OrderStatusDto.fromDomain(order)`) e, idealmente, habilitar `ClassSerializerInterceptor` + `@Expose()`/`excludeExtraneousValues` para garantir que apenas campos declarados no DTO sejam serializados — evitando vazamento futuro de campos do domínio em `items`/`history`.
  ```ts
  return OrderStatusDto.fromDomain(order);
  ```

---

## LOW

### L1 — Ausência de teste dedicado para o caminho 404 deste endpoint

- **Local:** arquivo todo (cobertura externa). Em `test/http.e2e.spec.ts` o `404` testado (linhas 54–61) é de `GET /products/:id`, não de `GET /orders/:id/status`. O happy path do status é coberto (linhas 75–79), mas o caminho de erro não.
- **Descrição:** não há asserção de que `GET /orders/<inexistente>/status` retorna `404` com `error: 'ORDER_NOT_FOUND'` e `correlationId`.
- **Impacto:** regressões no mapeamento `OrderNotFoundError → 404` (feito no `DomainExceptionFilter`) não seriam detectadas por este endpoint.
- **Correção sugerida:** adicionar um caso e2e:
  ```ts
  it('GET /orders/:id inexistente => 404 ORDER_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/orders/NAO-EXISTE/status').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: 'ORDER_NOT_FOUND' });
    expect(res.body).toHaveProperty('correlationId');
  });
  ```

### L2 — Documentação OpenAPI não declara o parâmetro de rota nem exemplos de erro completos

- **Local:** linhas 12–15.
- **Descrição:** há `@ApiOkResponse` e `@ApiNotFoundResponse`, mas falta `@ApiParam({ name: 'orderId', ... })` descrevendo formato/exemplo do id. Útil para consumidores do Swagger.
- **Impacto:** menor — apenas qualidade de documentação/DX.
- **Correção sugerida:** adicionar `@ApiParam({ name: 'orderId', example: '...', description: 'Identificador do pedido' })`.

### L3 — Nome do handler `status` pouco descritivo

- **Local:** linha 15 (`async status(...)`).
- **Descrição:** o método público se chama `status`, que colide semanticamente com o campo `status` do pedido e com o conceito HTTP de status. Algo como `getOrderStatus`/`findStatus` comunica melhor a intenção.
- **Impacto:** cosmético/manutenibilidade.
- **Correção sugerida:** renomear para `getOrderStatus`.

---

## Pontos positivos

- **Aderência hexagonal exemplar:** o controller depende apenas do use case (porta de aplicação) e de DTOs do próprio adapter HTTP; nenhuma referência a infra (Redis/Bull/ORM). A tradução erro-de-domínio→HTTP fica corretamente no `DomainExceptionFilter`, mantendo o domínio agnóstico de HTTP.
- **Tratamento de erro correto por delegação:** o `404` para pedido inexistente é coberto pelo use case (`throw new OrderNotFoundError`) + filtro global, sem `try/catch` vazio nem fallback silencioso aqui. O controller não engole exceções.
- **Tipagem limpa:** sem `any`, sem asserções de tipo inseguras (`as`), retorno tipado como `Promise<OrderStatusDto>`.
- **DI idiomática:** injeção via construtor, provider com escopo padrão (singleton) adequado a um handler stateless; sem efeitos colaterais no construtor.
- **Sem concorrência/atomicidade em jogo:** endpoint puramente de leitura (`GET`), idempotente por natureza; não há mutação de estoque/idempotência/fila neste arquivo, então não há race conditions a tratar aqui.
- **Documentação Swagger presente** (`@ApiTags`, `@ApiOkResponse`, `@ApiNotFoundResponse` com `ErrorDto`).

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto, seguro e bem arquitetado para sua responsabilidade (adapter de leitura). Não há achados CRITICAL/HIGH. Recomenda-se, antes de considerar "produção-hardened", endereçar **M1** (validação/fail-fast do `orderId` e distinção 400 vs 404) e **M2** (mapper centralizado + serialização baseada em DTO para evitar vazamento futuro de campos do domínio). Os itens LOW são melhorias incrementais de teste e DX.
