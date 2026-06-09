# Code Review — src/observability/metrics.controller.ts

## Resumo

Controller mínimo e idiomático que expõe o endpoint Prometheus `GET /metrics`, delegando 100% da lógica ao `MetricsService` e excluído do OpenAPI corretamente. O código em si está correto; as ressalvas são de natureza arquitetural/operacional: exposição do endpoint sem nenhum guard (vazamento de telemetria interna), `Content-Type` versionado de forma estática e ausência de tratamento de erro no `expose()`. Nenhum bug funcional.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 2          |
| LOW        | 2          |

---

## HIGH

### [HIGH-1] Endpoint `/metrics` exposto sem autenticação/guard nem segregação de rede
- **Local:** linhas 6–15 (todo o controller; especificamente o `@Get()` da linha 11)
- **Descrição:** O endpoint `GET /metrics` não aplica nenhum guard. O projeto já possui um mecanismo de proteção pronto — `src/interface/http/guards/admin-token.guard.ts` (`AdminTokenGuard`), usado por `admin.controller.ts` — mas ele não é aplicado aqui. O `MetricsService` chama `collectDefaultMetrics` e expõe contadores de negócio (`checkout_requests_total`, `oversell_prevented_total`, `queue_depth`, `stock_reservation_total`, latências de ERP etc.), além de métricas default do processo Node (uso de memória/heap, event loop lag, file descriptors, versão do Node/V8 via `nodejs_version_info`).
- **Impacto:** Em uma aplicação de e-commerce/checkout, esse payload é inteligência operacional sensível: volume de pedidos, taxa de conflito/replay de idempotência, profundidade de fila, e fingerprinting de runtime (versão exata do Node/V8 facilita correlação com CVEs). Se o app for exposto diretamente (sem um reverse-proxy/service mesh filtrando `/metrics`), qualquer um na rede consegue raspar tudo. O `main.ts` não registra `APP_GUARD` global, então não há rede de segurança padrão.
- **Correção sugerida:** A decisão correta depende do modelo de deploy, mas o endpoint não deveria ficar acessível ao público por padrão. Duas opções:
  1. **Proteger no app** com o guard já existente (ou um token específico de scraping):
     ```ts
     import { UseGuards } from '@nestjs/common';
     import { AdminTokenGuard } from '../interface/http/guards/admin-token.guard';

     @ApiExcludeController()
     @UseGuards(AdminTokenGuard)
     @Controller('metrics')
     export class MetricsController { /* ... */ }
     ```
  2. **Documentar explicitamente** (README/ADR) que `/metrics` DEVE ficar atrás de um proxy/network policy que só permite o scraper do Prometheus, e idealmente bindar essa rota em uma porta interna separada. Em qualquer caso, a ausência de proteção precisa ser uma escolha consciente e registrada, não um esquecimento.

---

## MEDIUM

### [MED-1] `Content-Type` com `version=0.0.4` hard-coded pode divergir do formato real do prom-client
- **Local:** linha 12 — `@Header('Content-Type', 'text/plain; version=0.0.4')`
- **Descrição:** O header de versão do formato Prometheus está fixo em `0.0.4`, mas o corpo da resposta é gerado por `this.registry.metrics()` (linha 87 do service). O `prom-client` expõe a string canônica do content-type em `registry.contentType`. Fixar a versão à mão cria uma fonte dupla de verdade: se uma futura atualização do prom-client passar a emitir OpenMetrics (`application/openmetrics-text; version=1.0.0`) ou mudar o `version`, o header anunciado deixará de corresponder ao payload.
- **Impacto:** Scrapers estritos (ou negociação de OpenMetrics) podem interpretar mal o corpo. É um risco de manutenção silencioso — não quebra hoje, mas quebra numa atualização de dependência sem nenhum aviso.
- **Correção sugerida:** Derivar o content-type da própria registry, eliminando o valor mágico. Como `@Header` é estático, mova para uma resposta explícita:
  ```ts
  import { Res } from '@nestjs/common';
  import type { Response } from 'express';

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.expose());
  }
  ```
  Alternativamente, exponha um getter `contentType` no `MetricsService` para não vazar a `registry` diretamente ao controller (ver MED-2).

### [MED-2] Ausência de tratamento de erro em `expose()` / `registry.metrics()`
- **Local:** linhas 13–14 (`scrape`) e service linhas 86–88 (`expose`)
- **Descrição:** `registry.metrics()` é `async` e pode rejeitar (ex.: um coletor custom registrado lançando exceção durante a coleta). Não há `try/catch` em nenhuma das camadas. Uma rejeição vira um 500 padrão e, sem um filtro específico para essa rota, pode poluir os logs de erro e — pior — derrubar a observabilidade exatamente quando ela é mais necessária (durante um incidente).
- **Impacto:** Um scrape que falha sem degradação graciosa pode disparar alertas de "endpoint down" no Prometheus e mascarar o problema real. Em telemetria, falhar de forma resiliente costuma ser preferível a propagar a exceção.
- **Correção sugerida:** Embora hoje só haja coletores padrão (baixo risco real), vale blindar a coleta, retornando 500 com corpo textual previsível e logando a stack uma vez:
  ```ts
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    try {
      return await this.metrics.expose();
    } catch (err) {
      // logar a stack via logger injetado; não engolir silenciosamente
      throw new InternalServerErrorException('metrics collection failed');
    }
  }
  ```
  Nota: o `return this.metrics.expose()` atual (linha 14) não tem `await`. Funciona (a Promise é encadeada), mas sem `await` qualquer try/catch futuro nesse método não capturaria a rejeição — então adicionar `await` é pré-requisito do tratamento de erro.

---

## LOW

### [LOW-1] `return` de Promise sem `await` dificulta instrumentação futura
- **Local:** linha 14 — `return this.metrics.expose();`
- **Descrição:** Retornar a Promise sem `await` é correto em runtime, mas remove o frame do controller do stack trace em caso de rejeição e impede um `try/catch` local de funcionar (ver MED-2). É um micro-idiomatismo que custa caro no dia em que se quiser observar/tratar a falha.
- **Impacto:** Puramente de manutenibilidade/diagnóstico. Sem efeito funcional hoje.
- **Correção sugerida:** `return await this.metrics.expose();`.

### [LOW-2] Controller acopla-se ao formato textual sem um tipo de retorno semântico
- **Local:** linhas 13–14 — assinatura `scrape(): Promise<string>`
- **Descrição:** O contrato é "string de métricas em texto Prometheus", mas isso fica implícito. Não é um defeito, apenas uma oportunidade de clareza. Combinado com MED-1/MED-2, a forma mais limpa é o service expor tanto o corpo quanto o `contentType`, mantendo o controller fino e sem conhecer detalhes do prom-client.
- **Impacto:** Cosmético/arquitetural. Hoje o controller não viola a hexagonal (apenas orquestra HTTP e delega), então a observação é menor.
- **Correção sugerida:** Opcional — encapsular content-type no service (`get contentType()` retornando `this.registry.contentType`) para que o controller nunca precise saber a versão do formato nem tocar a `registry`.

---

## Pontos positivos

- **Responsabilidade única e fina:** o controller só faz roteamento HTTP e delega a coleta ao `MetricsService` — aderente à arquitetura hexagonal (nenhuma lógica de domínio ou de infra de métricas vaza para a camada HTTP).
- **`@ApiExcludeController()`** corretamente aplicado: `/metrics` é um contrato de scraping, não de negócio, e não polui o Swagger. O comentário explicando o porquê é excelente.
- **DI idiomática:** injeção por construtor com `private readonly`, provider gerenciado pelo `ObservabilityModule` (`@Global`), sem instanciação manual.
- **`Content-Type` textual** definido (mesmo com a ressalva de versionamento), evitando que o Nest serialize a resposta como JSON.
- **Cobertura e2e existente:** `test/http.e2e.spec.ts` valida `GET /metrics` (status 200 e presença de séries como `cache_requests_total`, `checkout_requests_total`, `worker_jobs_total`, `oversell_prevented_total`), garantindo que a fiação controller↔service funciona de ponta a ponta.

---

## Veredito

**Aprovado com ressalvas.**

O controller está funcionalmente correto e bem desenhado. A ressalva relevante é **HIGH-1 (exposição de `/metrics` sem guard nem segregação documentada)**: não é um bug, mas é uma decisão de segurança que, hoje, está implícita/ausente e deveria ser explicitada — seja aplicando o `AdminTokenGuard` já existente, seja documentando formalmente que a rota fica atrás de um proxy/network policy. MED-1 e MED-2 são melhorias de robustez recomendadas antes de considerar o componente "production-grade", mas não bloqueiam. Os achados LOW são cosméticos.
