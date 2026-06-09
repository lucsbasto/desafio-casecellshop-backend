# Code Review — src/observability/metrics.service.ts

## Resumo

`MetricsService` é um registry Prometheus central, simples e bem organizado, que declara
contadores/gauges/histogramas para cache, checkout, fila/worker, ERP e prevenção de overselling.
O código está sólido e correto; os labels declarados batem com todos os consumidores reais. Não há
bugs de correção nem race conditions. As ressalvas são de robustez de exposição (Content-Type) e de
aderência arquitetural (registry público mutável, default metrics no construtor).

| Severidade | Quantidade |
|-----------|-----------|
| CRITICAL  | 0 |
| HIGH      | 0 |
| MEDIUM    | 2 |
| LOW       | 4 |

---

## MEDIUM

### M1 — Content-Type da exposição não acompanha o formato real do prom-client 15
- **Local:** `metrics.service.ts:86-88` (`expose()`) em conjunto com `metrics.controller.ts:12`.
- **Descrição:** `expose()` retorna `this.registry.metrics()` (texto), mas o `MetricsService` não
  expõe o content-type correspondente. O controller hardcoda `text/plain; version=0.0.4`. Na versão
  instalada (prom-client 15.1.3) o content-type canônico é `text/plain; version=0.0.4; charset=utf-8`
  (verificado: `Registry.PROMETHEUS_CONTENT_TYPE === 'text/plain; version=0.0.4; charset=utf-8'`).
  O header atual omite o `charset`, o que diverge do que a lib produz e pode causar interpretação
  incorreta de encoding por scrapers estritos.
- **Impacto:** Header de scraping potencialmente divergente do payload; manutenção frágil (string
  duplicada e fora de sincronia com a lib). É um contrato de scraping, então vale acertar.
- **Correção sugerida:** Fazer o service ser a fonte da verdade do content-type e o controller
  consumi-lo, eliminando a string hardcoded:
  ```ts
  // metrics.service.ts
  get contentType(): string {
    return this.registry.contentType; // 'text/plain; version=0.0.4; charset=utf-8'
  }
  async expose(): Promise<string> {
    return this.registry.metrics();
  }
  ```
  ```ts
  // metrics.controller.ts
  @Get()
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.expose());
  }
  ```

### M2 — `collectDefaultMetrics` no construtor torna o provider não reentrante e acopla a side-effects globais
- **Local:** `metrics.service.ts:23-24`.
- **Descrição:** `collectDefaultMetrics({ register: this.registry })` é executado no construtor. Embora
  o registry seja por-instância (bom), executar coleta de métricas default (que registra hooks de
  GC/event-loop/process via `perf_hooks`) como efeito colateral de construção do provider mistura
  inicialização "pesada" com a construção do objeto. Se em testes ou em múltiplos contextos de DI o
  provider for instanciado mais de uma vez (ex.: `Test.createTestingModule` repetido sem `@Global`
  reaproveitado), cada instância liga seus próprios coletores. Como cada um usa registry próprio não
  há erro de duplicate-registration, mas há acúmulo silencioso de timers/observers de GC entre
  instâncias não descartadas.
- **Impacto:** Risco de vazamento de observers (`PerformanceObserver`) em suites de teste que criam
  muitas instâncias; inicialização não idempotente fora do controle do ciclo de vida do Nest.
- **Correção sugerida:** Mover para `onModuleInit()` (lifecycle hook do Nest) e/ou guardar referência
  para permitir limpeza em `onModuleDestroy()`. Alternativamente, manter no construtor mas documentar
  que o provider deve ser singleton (escopo default do Nest já garante isso em produção):
  ```ts
  export class MetricsService implements OnModuleInit {
    onModuleInit() {
      collectDefaultMetrics({ register: this.registry });
    }
  }
  ```

---

## LOW

### L1 — `registry` público e `readonly` apenas na referência (mutável internamente)
- **Local:** `metrics.service.ts:10`.
- **Descrição:** `readonly registry = new Registry()` é exposto como público. `readonly` impede
  reatribuição da referência, mas não impede que terceiros chamem `registry.clear()`,
  `registry.resetMetrics()` ou registrem métricas avulsas, contornando o encapsulamento do service.
- **Impacto:** Superfície de manipulação indevida do estado de métricas a partir de qualquer
  consumidor com acesso ao service.
- **Correção sugerida:** Tornar `registry` `private` e expor apenas `expose()`/`contentType`. Nenhum
  consumidor atual referencia `metrics.registry` (verificado por grep), então o encapsulamento é
  seguro de aplicar.

### L2 — Acoplamento direto às métricas concretas (sem porta) — leve tensão com hexagonal
- **Local:** `metrics.service.ts:12-21` (campos públicos `Counter`/`Gauge`/`Histogram`).
- **Descrição:** Use cases de aplicação (`checkout.usecase.ts`, `checkout.worker.ts`,
  `list-products.usecase.ts`, `reconcile.usecase.ts`) dependem diretamente das instâncias concretas
  do prom-client (`metrics.checkoutRequests.inc(...)`, `metrics.workerDuration.startTimer()`). Isso
  vaza um detalhe de infraestrutura (prom-client) para a camada de aplicação, sem uma porta de
  domínio (`MetricsPort`) intermediando.
- **Impacto:** Troca do backend de métricas (ex.: OpenTelemetry metrics) exigiria tocar todos os use
  cases. Para observabilidade isso costuma ser um trade-off aceito, mas é uma divergência do estilo
  ports & adapters adotado no resto do projeto.
- **Correção sugerida:** Opcional. Se quiser consistência hexagonal, definir uma `MetricsPort` na
  camada de aplicação com métodos semânticos (`recordCheckout(outcome)`, `observeWorker(fn)`, etc.) e
  deixar este service como adapter. Caso contrário, documentar explicitamente que observabilidade é
  uma exceção pragmática às portas.

### L3 — Buckets de histograma fixos sem unidade/documentação de origem
- **Local:** `metrics.service.ts:41, 58, 70`.
- **Descrição:** Os buckets (`[0.01..2]`, `[0.05..5]`, `[0.05..2]`) são literais mágicos. Estão
  coerentes com os SLAs implícitos (segundos), mas não há comentário justificando os limites nem
  constante nomeada. Para checkout (`até o 202`) o bucket máximo de 2s pode subdimensionar caudas
  longas (tudo acima de 2s cai no `+Inf` sem granularidade).
- **Impacto:** Dificuldade de tunar SLOs; perda de visibilidade de p99 acima do maior bucket.
- **Correção sugerida:** Extrair para constantes nomeadas com comentário (ex.:
  `CHECKOUT_BUCKETS_SECONDS`) e considerar um bucket adicional (ex.: 5s) caso a cauda de checkout
  importe para alarmes.

### L4 — Sem teste unitário dedicado ao service
- **Local:** arquivo inteiro (não há `metrics.service.spec.ts`).
- **Descrição:** Não existe teste específico garantindo que (a) todas as métricas estão registradas
  com os nomes esperados, e (b) os `labelNames` correspondem aos labels usados pelos consumidores.
  Hoje a correspondência label↔consumidor é garantida só por inspeção. Um label incorreto em
  `.inc({ result: ... })` só falharia em runtime (prom-client lança em label desconhecido).
- **Impacto:** Regressões de naming/label passariam pela compilação e só apareceriam ao raspar
  `/metrics`.
- **Correção sugerida:** Adicionar um teste leve assertando nomes e labels presentes em
  `await service.expose()`, ex.: `expect(out).toContain('checkout_requests_total')` e exercitando
  um `.inc({ outcome: 'accepted' })` para validar o label set.

---

## Pontos positivos

- Registry **por-instância** (`new Registry()`) em vez do global default — evita colisões de
  duplicate-registration entre testes e é a prática recomendada.
- **Labels declarados batem 100% com os consumidores reais** (verificado por grep): `result` em
  cache/worker/erp/stock, `outcome` em checkout, gauge sem label em `queueDepth`, counter sem label
  em `oversellPrevented`. Nenhum descasamento que causaria exceção em runtime.
- Métricas **bem nomeadas** segundo convenção Prometheus (`_total` para counters, `_seconds` para
  durações, sufixos coerentes), com `help` descritivo.
- Cobertura de domínio alinhada ao SPEC (OBS-2): inclui explicitamente
  `oversell_prevented_total` e `stock_reservation_total`, centrais ao requisito de evitar overselling.
- `expose()` assíncrono respeita a assinatura `Promise<string>` de `registry.metrics()` (que é
  async em prom-client 15) — correto e sem `any`.
- Tipagem limpa: `Counter<string>`/`Gauge<string>`/`Histogram<string>`, sem `any` nem asserções
  inseguras.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto, sem bugs, sem race conditions e sem falhas de segurança. As ressalvas são de
robustez e estilo: ajustar o Content-Type para usar `registry.contentType` (M1) e mover
`collectDefaultMetrics` para o lifecycle do Nest e/ou garantir singleton (M2) elevam a qualidade sem
risco. Os itens LOW são melhorias incrementais (encapsular o registry, port de métricas opcional,
documentar buckets, adicionar teste). Nada bloqueia merge.
