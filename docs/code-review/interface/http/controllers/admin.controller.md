# Code Review — src/interface/http/controllers/admin.controller.ts

## Resumo

Controller fino e bem estruturado: delega a lógica ao `ReconcileUseCase`, aplica `AdminTokenGuard` no endpoint destrutivo e documenta via Swagger. Os problemas reais são poucos e de baixa severidade: um endpoint `GET /admin/health` redundante (já existe `HealthController`), ausência de rate limiting/idempotência no `POST /admin/reconcile` (que dispara ação destrutiva), e pequenas inconsistências de documentação/segurança que dependem do `AdminTokenGuard` (cujo modo fail-open é a fraqueza de segurança mais relevante do conjunto, embora resida no guard, não no controller).

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 2         |
| LOW        | 3         |

---

## MEDIUM

### M1 — `POST /admin/reconcile` é destrutivo, síncrono e sem rate limiting / proteção contra concorrência
- **Local:** linhas 15-21 (`runReconcile`)
- **Descrição:** O endpoint dispara `ReconcileUseCase.execute()`, que executa ações destrutivas/com efeitos colaterais (marca pedidos como `FAILED`, libera estoque via `stock.release`, reenfileira jobs). Não há rate limiting (`@Throttle`), nem qualquer mecanismo que impeça execuções concorrentes. Duas chamadas simultâneas (ex.: operador clicando duas vezes, ou um retry de cliente HTTP) processam o mesmo conjunto de candidatos `PENDING` em paralelo.
- **Impacto:** Risco de double-compensation de estoque e re-save concorrente do mesmo pedido. Mesmo que `transition`/`save` sejam idempotentes em status, o `Promise.all(order.items.map(item => stock.release(...)))` no use case pode ser executado duas vezes para o mesmo pedido entre duas requisições concorrentes, liberando estoque em dobro antes de o primeiro `save` consolidar o `FAILED`. O controller é o ponto natural para impor um guard-rail (lock/single-flight ou throttle) já que o use case não o faz.
- **Correção sugerida:** Aplicar throttling agressivo e/ou serialização. Mínimo:
  ```ts
  import { Throttle } from '@nestjs/throttler';

  @Post('reconcile')
  @UseGuards(AdminTokenGuard)
  @Throttle({ default: { limit: 1, ttl: 60_000 } }) // 1 execução por minuto
  @HttpCode(200) // POST sem corpo de criação retorna 200, não 201
  @ApiBearerAuth()
  @ApiOkResponse({ ... })
  async runReconcile(): Promise<ReconcileReport> { ... }
  ```
  Idealmente, complementar com um lock distribuído (Redis `SET NX`) no próprio use case para garantir single-flight entre instâncias/escalonador. Nota: o `ReconcileScheduler` provavelmente já chama o use case periodicamente — uma execução manual concorrente com a agendada é o cenário real de race.

### M2 — `@Post` sem `@HttpCode(200)` retorna `201 Created`, semântica incorreta
- **Local:** linha 15 (`@Post('reconcile')`) + linha 18 (`@ApiOkResponse`)
- **Descrição:** Por padrão, NestJS responde `201 Created` em métodos `@Post`. A operação de reconciliação não cria recurso — é um comando operacional que retorna um relatório. Além disso, o Swagger está anotado com `@ApiOkResponse` (200), gerando divergência entre o status real (201) e o documentado (200).
- **Impacto:** Contrato HTTP inconsistente: clientes/contratos OpenAPI esperam 200 (conforme `@ApiOkResponse`) mas recebem 201. Testes de contrato e consumidores podem falhar ou tratar o status incorretamente.
- **Correção sugerida:** Adicionar `@HttpCode(200)` (importando de `@nestjs/common`) ao `runReconcile`, alinhando com a anotação Swagger.

---

## LOW

### L1 — Endpoint `GET /admin/health` redundante e divergente do `HealthController`
- **Local:** linhas 23-27 (`health()`)
- **Descrição:** Já existe um `HealthController` (`src/interface/http/controllers/health.controller.ts`) registrado em `app.module.ts`, expondo `GET /health` com payload mais rico (`{ status, uptimeSeconds }`). O `GET /admin/health` deste controller duplica a responsabilidade com payload mais pobre (`{ status }`) e nome de método/rota concorrente.
- **Impacto:** Duplicação de superfície de health-check, dois contratos divergentes para a mesma intenção, maior custo de manutenção e confusão sobre qual endpoint é o canônico para probes (k8s liveness/readiness).
- **Correção sugerida:** Remover o método `health()` do `AdminController` e usar exclusivamente o `HealthController`. Se a intenção é um health *do subsistema admin/reconcile* (ex.: profundidade da fila), então deveria retornar métricas reais e ter nome distinto (ex.: `GET /admin/status`), não um `{ status: 'ok' }` estático.

### L2 — `GET /admin/health` não é protegido pelo `AdminTokenGuard` (inconsistência de namespace)
- **Local:** linha 23 (ausência de `@UseGuards(AdminTokenGuard)`)
- **Descrição:** O guard é aplicado apenas no `runReconcile`. O `GET /admin/health` fica público. Embora um health-check público costume ser aceitável, ele está sob o prefixo `/admin`, criando inconsistência: parte do namespace `admin` é protegida, parte não.
- **Impacto:** Baixo em si (retorna apenas `{ status: 'ok' }`), mas a inconsistência pode levar futuros endpoints adicionados ao controller a esquecerem o guard, assumindo que "tudo em /admin é protegido". Considerar aplicar o guard no nível da classe (`@UseGuards` no `@Controller`) e isentar explicitamente o health, ou (preferível, ver L1) remover o health daqui.
- **Correção sugerida:** Resolver via L1 (remover o método). Caso permaneça, documentar explicitamente que é intencionalmente público, ou mover o guard para o nível da classe.

### L3 — `@ApiOkResponse` sem `type`, descrição apenas em texto
- **Local:** linha 18 (`@ApiOkResponse({ description: ... })`) e linha 24
- **Descrição:** As anotações `@ApiOkResponse` não declaram `type`. Como `ReconcileReport` e `{ status }` são interfaces/tipos estruturais TypeScript (apagados em runtime), o Swagger não consegue inferir o schema do corpo de resposta automaticamente — o OpenAPI gerado não terá o shape de `ReconcileReport` (`requeued/failed/scanned`).
- **Impacto:** Documentação OpenAPI incompleta: consumidores e geradores de client SDK não recebem o schema da resposta, reduzindo o valor da documentação Swagger já presente.
- **Correção sugerida:** Expor um DTO/classe com `@ApiProperty` (ex.: `ReconcileReportDto`) e referenciá-lo: `@ApiOkResponse({ type: ReconcileReportDto, description: ... })`. Interfaces puras não funcionam para o gerador OpenAPI do Nest.

---

## Pontos positivos

- **Controller fino / aderência hexagonal:** delega 100% da lógica ao `ReconcileUseCase`, sem vazamento de regra de negócio ou infra no adapter de entrada. Excelente separação de camadas.
- **DI idiomática NestJS:** injeção por construtor com `readonly`, provider padrão (singleton), sem lifecycle manual.
- **Proteção do endpoint destrutivo:** `@UseGuards(AdminTokenGuard)` corretamente aplicado ao `reconcile`, com `@ApiBearerAuth()` documentando a exigência de token.
- **Sem `any`, sem asserções de tipo inseguras, sem catch vazios:** retornos tipados (`Promise<ReconcileReport>`), código limpo e de baixa complexidade.
- **Documentação Swagger presente** (`@ApiTags`, `@ApiOkResponse`), facilitando consumo.

> Observação de escopo: a fraqueza de segurança mais séria do conjunto é o **fail-open** do `AdminTokenGuard` (linhas 25-29: sem `ADMIN_TOKEN`, libera tudo) e a **comparação de token não constant-time** (`token !== expected`, vulnerável a timing attack). Ambos residem no guard, não neste arquivo, e devem ser tratados na revisão de `admin-token.guard.ts`. Mencionados aqui apenas porque impactam diretamente a segurança efetiva deste controller.

---

## Veredito

**Aprovado com ressalvas.**

O controller é sólido, fino e arquiteturalmente correto. Nenhum bug crítico ou alto. Recomenda-se, antes de produção: (M2) corrigir o status HTTP para 200 via `@HttpCode`, (M1) adicionar throttling/serialização ao endpoint destrutivo de reconciliação, e (L1) eliminar a duplicação do health-check com o `HealthController`. As demais ressalvas são cosméticas/documentais.
