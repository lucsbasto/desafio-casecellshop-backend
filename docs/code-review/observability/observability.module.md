# Code Review — src/observability/observability.module.ts

Módulo de composição NestJS que agrupa observabilidade: registra `MetricsController`, e provê/exporta `MetricsService` e `TracingService` como módulo `@Global`. O arquivo é trivial, sem lógica de negócio, e o grafo de DI foi verificado contra `AppModule`, `ApplicationModule`, `MetricsService` e `TracingService`. Nenhum defeito de correção, concorrência ou erro foi encontrado; as observações são de baixa severidade e arquiteturais.

| Severidade | Contagem |
|------------|----------|
| CRITICAL   | 0        |
| HIGH       | 0        |
| MEDIUM     | 0        |
| LOW        | 3        |

## CRITICAL

Nenhum achado.

## HIGH

Nenhum achado.

## MEDIUM

Nenhum achado.

> Observação de segurança (fora do escopo deste arquivo): o endpoint `GET /metrics` (registrado via `MetricsController` na linha 12) é exposto sem guard/authz. Isso é uma decisão correta e idiomática neste arquivo — a proteção de scraping de métricas é tipicamente feita na borda (rede/ingress, `ServiceMonitor` em namespace restrito) e não no módulo. Mencionado apenas para rastreabilidade; **não** é um defeito do `observability.module.ts`. A revisão de authz pertence ao `metrics.controller.ts`/camada de infra.

## LOW

### LOW-1 — Dependência global implícita não documentada para consumidores
- **Local:** linha 10 (`@Global()`), linhas 13–14 (`providers`/`exports`).
- **Descrição:** Por ser `@Global`, `MetricsService` e `TracingService` ficam disponíveis em toda a aplicação sem que os módulos consumidores (`ApplicationModule` e os providers da camada de aplicação) precisem importar `ObservabilityModule`. Isso torna a dependência sobre observabilidade invisível na leitura dos módulos que a consomem (já observado em `docs/code-review/application/application.module.md`).
- **Impacto:** Baixo. Apenas legibilidade/manutenção. O grafo resolve corretamente em runtime; a única forma de quebrar seria remover o `@Global`, momento em que vários módulos passariam a falhar por dependência não declarada. É uma escolha arquitetural deliberada do projeto (há também `InfrastructureModule` global).
- **Correção sugerida:** Manter como está é defensável. Se quiser reduzir acoplamento implícito, documente no header do módulo que o `@Global` é intencional e que removê-lo exige adicionar `imports: [ObservabilityModule]` nos consumidores. Snippet:
  ```ts
  /**
   * Global observability module: metrics (prom-client) and tracing (spans).
   * @Global é intencional — consumidores (ApplicationModule etc.) NÃO importam este módulo.
   * Remover @Global exige adicionar ObservabilityModule aos imports de cada consumidor.
   * O logger (nestjs-pino) é configurado no AppModule via LoggerModule.forRoot.
   */
  ```

### LOW-2 — Acoplamento entre escopo `@Global` e ciclo de vida singleton (ring buffer do TracingService)
- **Local:** linha 13 (`providers: [..., TracingService]`).
- **Descrição:** `TracingService` mantém estado mutável em processo (ring buffer de 1000 spans — `tracing.service.ts:28-31`). Como provider de módulo `@Global` sem escopo declarado, é singleton, que é exatamente o comportamento desejado (um único buffer compartilhado). O risco latente é apenas se alguém futuramente marcar o provider como `REQUEST`/`TRANSIENT` scope: o buffer deixaria de ser compartilhado e o `recentSpans()` perderia sentido, sem nenhum erro visível.
- **Impacto:** Baixo. Nenhum bug atual. É uma armadilha de manutenção: a corretude do `TracingService` depende implicitamente do escopo singleton padrão definido aqui.
- **Correção sugerida:** Nenhuma mudança necessária. Opcionalmente, deixar explícito via comentário que esses providers devem permanecer em escopo singleton (default), dado que carregam estado em processo.

### LOW-3 — Ausência de teste do módulo (compilação do grafo de DI)
- **Local:** arquivo inteiro (não há `observability.module.spec.ts`).
- **Descrição:** Não existe teste que compile o módulo (`Test.createTestingModule({ imports: [ObservabilityModule] }).compile()`) para garantir que o grafo resolve e que `MetricsService`/`TracingService` são realmente exportados. Para um arquivo de composição puro isso é aceitável (a verdade do grafo emerge nos testes e2e/app), mas um teste de fumaça barato protege contra regressões silenciosas em refactors de DI.
- **Impacto:** Baixo. A montagem do módulo já é exercitada indiretamente pelo boot da aplicação.
- **Correção sugerida (opcional):** Teste de fumaça:
  ```ts
  it('compila e exporta os providers de observabilidade', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule],
    }).compile();
    expect(moduleRef.get(MetricsService)).toBeInstanceOf(MetricsService);
    expect(moduleRef.get(TracingService)).toBeInstanceOf(TracingService);
  });
  ```

## Pontos positivos

- **Composição mínima e correta:** o arquivo faz exatamente uma coisa (compor observabilidade) e nada além disso — sem lógica, sem efeitos colaterais, sem `any` nem asserções de tipo inseguras.
- **`exports` consistente com `providers`:** tudo que é declarado como provider e usado fora (`MetricsService`, `TracingService`) é exportado; `MetricsController` corretamente não é exportado (controllers não se exportam).
- **Uso idiomático de `@Global`:** coerente com o padrão do projeto (`InfrastructureModule` também é global), evitando reimportações repetitivas de uma dependência transversal.
- **Separação de responsabilidades:** o logger (nestjs-pino) é deliberadamente configurado no `AppModule` (documentado no header, linhas 7–8), evitando duplicação de configuração de logging aqui.
- **Aderência hexagonal:** módulo de infraestrutura/observabilidade não vaza para o domínio; o domínio depende apenas de portas, não deste módulo.

## Veredito

**Aprovado.** O arquivo é sólido e idiomático para um módulo de composição NestJS. As três observações são de baixa severidade (legibilidade da dependência global, armadilha de escopo do estado do tracer e ausência de teste de fumaça) e não bloqueiam. Nenhuma ação obrigatória.
