# Code Review — src/interface/http/controllers/health.controller.ts

## Resumo

Controller de _liveness_ extremamente simples e correto: expõe `GET /health` retornando
`{ status: 'ok', uptimeSeconds }`. Não há bugs de correção, concorrência ou segurança no
código atual. As observações são todas de natureza arquitetural/operacional: o endpoint é
_liveness_ puro e não cobre _readiness_ (Redis/BullMQ), e não há teste associado.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 1          |
| LOW        | 3          |

---

## MEDIUM

### M1 — Ausência de _readiness probe_ (só existe _liveness_)
- **Local:** arquivo inteiro (linhas 6–11); registro em `src/app.module.ts:31`.
- **Descrição:** O serviço depende criticamente de Redis (`ioredis`) e de filas BullMQ para
  o fluxo de checkout assíncrono/idempotência. O único endpoint de saúde é um _liveness_ que
  retorna `ok` incondicionalmente, sem verificar dependências externas. Não existe um
  `/health/ready` (readiness) que indique se o processo consegue de fato atender tráfego.
- **Impacto:** Em orquestradores (Kubernetes/ECS), um _readiness_ que sempre retorna 200
  fará o balanceador rotear tráfego para uma instância cujo Redis está fora, resultando em
  falhas de checkout que poderiam ser evitadas drenando a instância. Também impede
  _zero-downtime deploys_ corretos (a instância é marcada pronta antes de as conexões
  subirem). Para um sistema de e-commerce com estoque/idempotência em Redis, isso é
  operacionalmente relevante.
- **Correção sugerida:** Manter este `/health` como _liveness_ (correto), e adicionar um
  endpoint de _readiness_ separado que faça um `PING` no Redis e cheque a conexão das filas.
  `@nestjs/terminus` não está nas dependências, então uma checagem manual leve é suficiente:

  ```ts
  @Get('ready')
  @ApiOkResponse({ description: 'Readiness check' })
  async ready(): Promise<{ status: string; redis: 'up' | 'down' }> {
    try {
      await this.redis.ping(); // Redis injetado via DI
      return { status: 'ok', redis: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', redis: 'down' });
    }
  }
  ```

  Observação: deve retornar status HTTP != 2xx quando degradado, para o orquestrador
  interpretar corretamente. Se for decisão de escopo manter apenas _liveness_, documentar
  explicitamente que readiness não é coberto.

---

## LOW

### L1 — Sem teste associado (`health.controller.spec.ts` inexistente)
- **Local:** diretório `src/interface/http/controllers/` (nenhum `*.controller.spec.ts` no projeto).
- **Descrição:** Não há nenhum teste para este controller (nem para os demais). Embora o
  método seja trivial, um teste de contrato barato evita regressões na forma do payload
  (ex.: alguém trocar `uptimeSeconds` por `uptime` quebra _scrapers_/dashboards).
- **Impacto:** Baixo, mas o `jest.config` já coleta cobertura de `src/**` e este arquivo
  ficará sempre como _gap_ de cobertura.
- **Correção sugerida:** Adicionar um spec mínimo:

  ```ts
  it('retorna status ok e uptime inteiro >= 0', () => {
    const res = new HealthController().check();
    expect(res.status).toBe('ok');
    expect(Number.isInteger(res.uptimeSeconds)).toBe(true);
    expect(res.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
  ```

### L2 — Tipo de retorno _inline_ em vez de DTO/schema do Swagger
- **Local:** linha 9 (`check(): { status: string; uptimeSeconds: number }`) e linha 8 (`@ApiOkResponse`).
- **Descrição:** O `@ApiOkResponse` declara apenas `description`, sem `type`/`schema`. Assim, o
  OpenAPI gerado não documenta o _shape_ da resposta (`status`, `uptimeSeconds`). O tipo de
  retorno é um literal _inline_ anônimo, não reaproveitável.
- **Impacto:** Baixo — apenas qualidade de documentação/contrato. Consumidores do
  `openapi.json` não veem o corpo da resposta de health.
- **Correção sugerida:** Extrair um `HealthResponseDto` com `@ApiProperty` e referenciá-lo:
  `@ApiOkResponse({ type: HealthResponseDto })`. Alinha com o padrão dos demais controllers
  (products/orders/checkout) que provavelmente já usam DTOs.

### L3 — `status` como `string` literal mágico, sem enum/constante
- **Local:** linha 10 (`status: 'ok'`) e tipo `status: string` (linha 9).
- **Descrição:** O valor `'ok'` é um literal solto e o tipo é `string` genérico em vez de um
  _union_ literal (`'ok' | 'degraded'`). Se futuramente o endpoint passar a reportar estados
  degradados, não há tipagem que force consistência.
- **Impacto:** Muito baixo; cosmético/futuro-prova.
- **Correção sugerida:** Tipar como `status: 'ok'` (ou `'ok' | 'degraded'`) no retorno, ou
  usar a constante do DTO sugerido em L2.

---

## Pontos positivos

- **Correção:** Lógica impecável. `Math.floor(process.uptime())` é a forma idiomática de
  expor uptime em segundos inteiros; `process.uptime()` nunca é negativo nem `NaN`, então não
  há edge case a tratar.
- **Sem efeitos colaterais / stateless:** Método síncrono, puro, sem I/O — não há risco de
  _race condition_, vazamento de recurso ou _await_ em loop. Ideal para um _liveness probe_
  (rápido e sem dependências externas, exatamente como deve ser).
- **Segurança:** Não expõe segredos nem dados sensíveis; `uptime` é informação benigna. Sem
  entrada do usuário, logo sem superfície de injeção/validação. Adequado deixar sem guard
  (probes de saúde normalmente são públicas para o orquestrador).
- **Aderência hexagonal:** Controller na camada de interface, sem vazamento de domínio/infra.
  Não injeta nada que não precise. Uso correto de `@Controller`/`@Get` e tags Swagger.
- **Idiomatismo NestJS:** Decorators corretos, _provider scope_ default (singleton) apropriado,
  registrado corretamente no `app.module.ts`.

---

## Veredito

**Aprovado.**

O arquivo está correto, seguro e idiomático para sua função de _liveness probe_. Nenhum
achado CRITICAL/HIGH. As recomendações são melhorias incrementais: a mais valiosa (M1) é
adicionar um _readiness probe_ que cheque Redis/BullMQ — importante operacionalmente para
este domínio de checkout assíncrono, mas fora do escopo estrito deste arquivo. Os itens LOW
(teste, DTO de resposta, tipagem do `status`) são polimento opcional.
