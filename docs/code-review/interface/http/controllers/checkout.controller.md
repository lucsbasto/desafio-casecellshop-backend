# Code Review — src/interface/http/controllers/checkout.controller.ts

## Resumo

O controller é fino, idiomático e bem alinhado à arquitetura hexagonal: delega toda a lógica ao `CheckoutUseCase` e não vaza infraestrutura. Os achados são de baixa/média gravidade, concentrados em **falta de validação/bounding do header `Idempotency-Key`** (que vira chave de armazenamento), **ausência total de authn/authz** e **divergência entre as respostas documentadas no Swagger e as efetivamente possíveis**. Nenhum bug crítico de correção ou concorrência no próprio controller.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 1         |
| MEDIUM     | 3         |
| LOW        | 3         |

---

## HIGH

### H1 — `Idempotency-Key` aceito sem validação de tamanho/charset (vira chave de armazenamento)

- **Local:** linha 38 (`@Headers('idempotency-key') idempotencyKey?: string`) → propagado em 42 para `this.checkout.execute({ ..., idempotencyKey })`.
- **Descrição:** O header é lido como `string` crua, sem nenhuma validação. Ele é repassado ao `CheckoutUseCase`, que o usa diretamente como chave em `this.idempotency.remember(key, orderId, ...)` (use-case, linha 88). O `CheckoutItemDto.productId` (dto linha 19-24) é deliberadamente restrito a `^[A-Za-z0-9_-]+$` e `MaxLength(64)` **justamente porque "productId flows straight into Redis keys"**. O `Idempotency-Key` segue o mesmo caminho conceitual (compõe uma chave de idempotência, tipicamente `idem:<key>` no Redis) mas **não recebe nenhuma proteção equivalente**.
- **Impacto:**
  - **Abuso de memória/keyspace:** um cliente pode enviar um header de megabytes, ou milhões de chaves distintas com TTL longo, inflando o store de idempotência (Redis) — vetor de DoS/memory-pressure.
  - **Colisão/poluição de keyspace:** caracteres como `:`, `*`, `\n`, espaços ou bytes de controle dentro da chave podem colidir com convenções de namespace, quebrar pattern-matching (`KEYS idem:*`, `SCAN`) ou logs estruturados, dependendo do adapter.
  - **Inconsistência de design:** a mesma classe de risco foi mitigada para `productId` e deixada aberta aqui.
- **Correção sugerida:** validar e limitar o header. Como `@Headers` não passa pelo `ValidationPipe` do body, valide explicitamente. Opção idiomática: um `ParseHeaderPipe`/pipe customizado, ou validação no DTO via um header-DTO. Mínimo viável no controller:

```ts
private static readonly IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

async start(
  @Body() body: CheckoutRequestDto,
  @Headers('idempotency-key') idempotencyKey?: string,
): Promise<CheckoutAcceptedDto> {
  if (idempotencyKey !== undefined && !CheckoutController.IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new BadRequestException('Idempotency-Key inválida: use [A-Za-z0-9_-], até 128 chars');
  }
  // ...
}
```

Idealmente extrair para um pipe reutilizável (`@Headers('idempotency-key', IdempotencyKeyPipe)`) para manter o controller limpo e testável.

---

## MEDIUM

### M1 — Ausência total de autenticação/autorização no endpoint de checkout

- **Local:** classe `CheckoutController` (linhas 14-47) — nenhum `@UseGuards(...)`, nenhum decorator de auth.
- **Descrição:** `POST /checkout` cria pedidos, reserva estoque atomicamente e enfileira jobs — operações com efeito colateral real e custo (reserva de estoque, profundidade de fila, gravação de pedido) — sem qualquer guard de autenticação/autorização.
- **Impacto:** qualquer cliente não autenticado pode reservar estoque em massa (oversell-prevention vira vetor de **negação de estoque**: reservar tudo e nunca pagar), inflar a fila e poluir o repositório de pedidos. Mesmo num desafio, a falta de um `@UseGuards` (ou comentário explícito de que auth é responsabilidade de camada externa/API gateway) é uma lacuna de segurança relevante.
- **Correção sugerida:** aplicar um guard (`@UseGuards(AuthGuard)`) ou, se a autenticação é terminada por um gateway/edge, documentar isso explicitamente (comentário + ADR) e idealmente um rate-limit (`@nestjs/throttler`) no endpoint para conter abuso de reserva.

### M2 — Respostas possíveis não documentadas no Swagger (404 e 500)

- **Local:** decorators de resposta, linhas 27-35 (`@ApiAcceptedResponse`, `@ApiBadRequestResponse`, `@ApiConflictResponse`).
- **Descrição:** O fluxo a jusante pode lançar `ProductNotFoundError`, que o `DomainExceptionFilter` mapeia para **404 NOT_FOUND** (filter, linhas 23-25), e qualquer erro inesperado vira **500** (filter, linha 33/65). Nenhum dos dois está documentado. Além disso, o `@ApiConflictResponse` descreve "Estoque insuficiente ou requisição duplicada", mas o cenário de produto inexistente sai como 404, não 409.
- **Impacto:** contrato OpenAPI incompleto. Clientes gerados a partir do Swagger não tratarão 404/500, e a descrição do 409 induz a erro (sugere que produto ausente também seria 409/conflito).
- **Correção sugerida:** adicionar `@ApiNotFoundResponse({ type: ErrorDto, description: 'Produto inexistente' })` e `@ApiInternalServerErrorResponse({ type: ErrorDto })`, e ajustar a descrição do 409 para cobrir apenas estoque insuficiente + requisição duplicada.

### M3 — `Idempotency-Key` vazio ("") tratado como ausente apenas por coincidência de fluxo

- **Local:** linha 42, em conjunto com use-case linhas 77-82.
- **Descrição:** Se o cliente enviar `Idempotency-Key:` vazio, chega `idempotencyKey === ''`. No use-case, `input.idempotencyKey ?? randomUUID()` (linha 77) **não** trata `''` como ausente (`??` só cobre `null`/`undefined`), então uma string vazia seria usada como chave real de idempotência — e o `if (!input.idempotencyKey)` (linha 78) a trataria como ausente para fins de log, gerando comportamento inconsistente (loga "sem Idempotency-Key" mas usa `''` como chave). O controller é o ponto natural para normalizar.
- **Impacto:** chave de idempotência vazia compartilhada entre clientes distintos → potencial colisão de idempotência (dois pedidos diferentes com `key=''` colapsando em um), além de logs enganosos.
- **Correção sugerida:** normalizar no controller (ou cobrir pela validação de H1, que rejeita `''` por `{1,128}`). Ex.: `const key = idempotencyKey?.trim() || undefined;` antes de repassar — alinhando a semântica "vazio = ausente".

---

## LOW

### L1 — Fallback `getCorrelationId() ?? 'unknown'` é código morto

- **Local:** linha 43.
- **Descrição:** O `CorrelationMiddleware` é aplicado a `forRoutes('*')` (app.module linha 36) e **sempre** estabelece um `correlationId` (middleware linhas 16-21). Logo, dentro de qualquer handler HTTP, `getCorrelationId()` nunca retorna `undefined`. O fallback `'unknown'` jamais é exercido neste caminho.
- **Impacto:** baixo; é defensivo, mas mascara silenciosamente um eventual erro de configuração (se o middleware deixasse de cobrir a rota, o pedido seguiria com `correlationId: 'unknown'` em vez de falhar visivelmente). Também é levemente enganoso para quem lê o código.
- **Correção sugerida:** manter o fallback é aceitável, mas considere `getCorrelationId() ?? randomUUID()` (consistente com o resto do código que gera IDs) ou um comentário explicando que é guarda defensiva. Não bloqueante.

### L2 — Acoplamento do controller ao formato do DTO de saída (montagem manual)

- **Local:** linha 45 (`return { orderId: order.id, status: order.status, replay };`).
- **Descrição:** O controller monta o `CheckoutAcceptedDto` manualmente a partir do `Order` de domínio. É correto e até desejável (não vaza o agregado inteiro), mas a montagem está inline; se o DTO crescer, a lógica de mapeamento se espalha.
- **Impacto:** manutenibilidade marginal. Hoje está ótimo (3 campos).
- **Correção sugerida:** nenhuma ação necessária agora. Se a resposta evoluir, extrair um mapper (`CheckoutAcceptedDto.from(order, replay)`).

### L3 — Nome do parâmetro injetado (`checkout`) colide conceitualmente com o método/rota

- **Local:** linha 17 (`private readonly checkout: CheckoutUseCase`) usado em 40.
- **Descrição:** `this.checkout.execute(...)` lê bem, mas `checkout` como nome de dependência é genérico; `checkoutUseCase` deixaria explícito que é o caso de uso (consistente com a convenção do projeto, que sufixa `UseCase`/`Service`).
- **Impacto:** cosmético.
- **Correção sugerida:** renomear para `checkoutUseCase` (opcional).

---

## Pontos positivos

- **Aderência hexagonal exemplar:** o controller depende apenas do caso de uso da camada de aplicação; zero vazamento de infraestrutura (Redis/BullMQ) e zero lógica de negócio no adapter HTTP.
- **DI idiomática NestJS:** injeção por construtor, provider singleton implícito, sem `new` manual.
- **`@HttpCode(HttpStatus.ACCEPTED)` correto** para o padrão assíncrono 202 (pedido `PENDING` + enfileiramento), coerente com o design "save-before-enqueue" do use-case.
- **Documentação OpenAPI presente e em PT-BR**, incluindo o header de idempotência e o significado do campo `replay`.
- **Validação de entrada robusta no `CheckoutRequestDto`** (charset de `productId`, limites de quantidade, `ArrayMaxSize(50)` para conter fan-out), combinada com `ValidationPipe` global (`whitelist` + `forbidNonWhitelisted` + `transform`) em main.ts.
- **Tipagem forte:** sem `any`, sem asserções de tipo inseguras; retorno tipado como `Promise<CheckoutAcceptedDto>`.
- **Tratamento de erros delegado corretamente** ao `DomainExceptionFilter` global — o controller não engole exceções nem mascara stack traces.

---

## Veredito

**Aprovado com ressalvas.**

O controller em si é sólido, idiomático e arquiteturalmente limpo. As ressalvas são tratáveis e em sua maioria de hardening: a prioritária é **H1 (validar/limitar o `Idempotency-Key` antes de usá-lo como chave de armazenamento)**, seguida da decisão consciente sobre **M1 (authn/authz ou rate-limit)** e da correção de contrato **M2 (respostas 404/500 no Swagger)**. M3/L1-L3 são refinamentos. Nenhum achado bloqueia funcionalmente, mas H1 e M1 devem ser endereçados antes de tráfego não confiável.
