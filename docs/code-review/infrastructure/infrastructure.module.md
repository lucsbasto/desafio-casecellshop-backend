# Code Review — src/infrastructure/infrastructure.module.ts

Módulo de composição (composition root) da camada de infraestrutura: faz o wiring das portas para os adapters memory/redis via `useFactory`, decide o driver por configuração e semeia o estoque no boot. O arquivo é, no geral, sólido, idiomático em NestJS e respeita a arquitetura hexagonal (só conhece portas + adapters concretos, nunca o domínio acopla a infra). Os achados são majoritariamente de comportamento de seed em modo Redis e detalhes de robustez/idiomatismo, sem bugs críticos no wiring em si.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## HIGH

### H1 — `StockSeeder` sobrescreve o estoque incondicionalmente, inclusive em modo Redis (linhas 103-115, 110-114)

**Local:** linhas 110-114 (`onModuleInit` / loop de `stock.init`).

**Descrição:** O `StockSeeder` roda em todo boot e chama `this.stock.init(p.id, p.stock)` para cada produto, independentemente do driver de estoque. Em modo `STOCK_DRIVER=redis`, `init` faz um `SET` do saldo no Redis (saldo compartilhado e persistente). Consequências:

- **Clobber do saldo real:** a cada restart do processo o estoque volta ao valor de seed do catálogo (`PRODUCT_SEED`), descartando todas as reservas/baixas já efetuadas. Num ambiente que pretende usar Redis como fonte de verdade do saldo, isso reintroduz overselling silencioso após qualquer deploy/restart.
- **Race entre instâncias:** num deploy multi-instância (que é justamente o motivo de existir o driver Redis), cada réplica executa o seed no boot concorrentemente, podendo sobrescrever o saldo de outra réplica que já está atendendo tráfego.

O próprio comentário do header (linhas 99-102) reconhece que isso é "para o demo", mas o código não tem nenhuma guarda que limite o seed ao modo de desenvolvimento/memória.

**Impacto:** Em produção/Redis, perda de consistência de estoque a cada restart e janela de corrida no boot — exatamente a categoria de falha que o resto do sistema (Lua atômico, idempotência) tenta evitar.

**Correção sugerida:** Tornar o seed condicional ao ambiente/driver, ou usar uma inicialização idempotente (`SETNX`/init-if-absent) em vez de `SET` incondicional. Exemplo no módulo, injetando o config e pulando o seed quando o estoque é Redis (ou só semeando em `env !== 'production'`):

```ts
class StockSeeder implements OnModuleInit {
  private readonly logger = new Logger(StockSeeder.name);
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(STOCK_PORT) private readonly stock: StockPort,
    @Inject(PRODUCT_REPO_PORT) private readonly products: ProductRepositoryPort,
  ) {}

  async onModuleInit(): Promise<void> {
    // Seed apenas em memória (demo). Em Redis o saldo é persistente/compartilhado
    // e não deve ser sobrescrito a cada boot.
    if (this.cfg.drivers.stock === 'redis' && this.cfg.env === 'production') {
      this.logger.log('Seed de estoque ignorado (driver=redis em produção)');
      return;
    }
    const all = await this.products.findAll();
    await Promise.all(all.map((p) => this.stock.init(p.id, p.stock)));
    this.logger.log(`Estoque semeado para ${all.length} produtos`);
  }
}
```

Alternativamente, expor um método `initIfAbsent` na `StockPort` (Lua `SET ... NX`) para tornar o seed idempotente sem clobber.

---

## MEDIUM

### M1 — `await` sequencial dentro do loop de seed (linha 112)

**Local:** linha 112 — `for (const p of all) await this.stock.init(p.id, p.stock);`.

**Descrição:** O loop aguarda cada `init` em série. Para o catálogo atual (5 itens) é irrelevante, mas o padrão é um N+1 de round-trips ao Redis no boot e escala linearmente com o tamanho do catálogo, atrasando o `onModuleInit` (que bloqueia o readiness do app).

**Impacto:** Boot mais lento e potencialmente perceptível com catálogos grandes; má prática que tende a ser copiada.

**Correção sugerida:** Paralelizar com `Promise.all` (vide snippet em H1), ou usar um pipeline/`mset` no adapter Redis se a porta permitir. Como as operações de seed são independentes entre produtos, não há motivo para serializá-las.

### M2 — Ausência de validação de invariantes da configuração no wiring (linhas 64-73, 91-96)

**Local:** `QueueProvider` (64-73) e `ErpProvider` (91-96), que consomem valores numéricos de `loadConfig`.

**Descrição:** `loadConfig` (em `config/app-config.ts`) faz coerção via `Number(...)` com fallback para default quando `NaN`, mas não valida intervalos: `failRate` pode vir > 1 ou negativo, `maxLatencyMs < minLatencyMs`, `maxAttempts <= 0`, `backoffMs` negativo. O módulo repassa esses valores diretamente aos adapters (`BullMqQueueAdapter`, `FakeErpClient`) sem nenhuma checagem. Um `WORKER_MAX_ATTEMPTS=0` por exemplo configuraria a fila com `attempts: 0`, alterando silenciosamente o comportamento de retry/DLQ.

**Impacto:** Configuração inválida via env não falha rápido (fail-fast); o sistema sobe com comportamento degradado/silencioso difícil de diagnosticar. Em hexagonal, a borda (config → infra) é o lugar certo para validar.

**Correção sugerida:** Validar a config no `loadConfig` (ou num provider de validação) com clamps/asserts explícitos — por exemplo `failRate` em `[0,1]`, `maxAttempts >= 1`, `maxLatencyMs >= minLatencyMs` — lançando erro descritivo no boot quando violado. Uma lib de schema (zod) ou checagens manuais resolvem; o importante é falhar no startup, não em runtime.

---

## LOW

### L1 — `StockSeeder` sem decorator `@Injectable()` (linhas 103-115)

**Local:** declaração da classe (linha 103).

**Descrição:** A classe é registrada diretamente no array `providers` (linha 128) como class provider, o que faz o Nest resolvê-la mesmo sem `@Injectable()`. Funciona porque ela não é injetada em outro lugar, mas o idiomático é decorá-la — alinha com `RedisLifecycle` (que usa `@Injectable()`) e evita surpresa caso passe a ser injetada futuramente.

**Impacto:** Inconsistência estilística; risco baixo de erro de DI se a classe for reutilizada.

**Correção sugerida:** Anotar `@Injectable()` na `StockSeeder`, padronizando com `RedisLifecycle`.

### L2 — `requireRedis` duplica a lógica de "driver redis exige conexão" (linhas 27-30, 39/48/57)

**Local:** helper `requireRedis` (27-30), usado em Cache/Stock/Idempotency.

**Descrição:** A invariante "se driver=redis então a conexão não pode ser nula" é checada no consumidor, enquanto a decisão de criar (ou não) a conexão vive em `redis.provider.ts` (`anyRedisDriver`). A lógica está correta e o guard é defensivo, mas a invariante fica espalhada em duas camadas; se as condições divergirem (ex.: alguém mudar `anyRedisDriver`), o erro só aparece em runtime na factory. A mensagem de erro também não diz qual driver disparou.

**Impacto:** Baixo — apenas manutenibilidade/clareza de diagnóstico.

**Correção sugerida:** Manter o guard, mas incluir o nome da porta/driver na mensagem (ex.: `Driver=redis selecionado para STOCK mas a conexão Redis é nula`), facilitando o diagnóstico. Opcionalmente centralizar a checagem.

### L3 — Constante mágica de latência `40` no `ProductRepoProvider` (linha 80)

**Local:** linha 80 — `new InMemoryProductRepository(undefined, cfg.env === 'test' ? 0 : 40)`.

**Descrição:** A latência simulada do "fake ERP" é hardcoded (`40` ms) no módulo, e o gate de teste usa `cfg.env === 'test'` em vez de uma flag de config. O valor de latência deveria, idealmente, vir de `AppConfig` (como já ocorre com `erp.minLatencyMs/maxLatencyMs` do `FakeErpClient`), mantendo todas as latências simuladas no mesmo lugar tipado.

**Impacto:** Baixo — número mágico e acoplamento a string de ambiente; dificulta ajuste sem recompilar.

**Correção sugerida:** Mover a latência do repositório para `AppConfig` (ex.: `productRepo.latencyMs`) com default 40 e 0 em teste, eliminando o literal e a comparação direta de `env`.

---

## Pontos positivos

- **Aderência hexagonal correta:** o módulo é o composition root e só conhece portas (`*_PORT`) + adapters; o domínio não é tocado e nenhum detalhe de infra vaza para cima. Seleção memory/redis por configuração é limpa.
- **Modo sem-Docker bem pensado:** `REDIS_CLIENT` é `null` quando nenhum driver é redis (via `anyRedisDriver`), e `requireRedis` garante fail-fast caso a combinação seja inconsistente.
- **Tratamento de erro explícito e não-silencioso** na cadeia de fila (vide `BullMqQueueAdapter`): `onExhausted` nunca é "engolido", o stack é logado. O módulo se beneficia disso ao apenas instanciar o adapter.
- **`@Global()` justificável** aqui: é infra transversal consumida por toda a aplicação, com `exports` explícitos e enxutos (só as portas).
- **Tipagem boa:** uso de `Provider`, `AppConfig`, sem `any`; `Redis | null` explícito nas factories. Comentários do `StockSeeder` e `RedisProvider` são honestos sobre o caráter de demo.

---

## Veredito

**Aprovado com ressalvas.**

O wiring está correto e idiomático e não há bug crítico no módulo em si. A ressalva principal é **H1**: o `StockSeeder` sobrescreve o saldo de estoque incondicionalmente, o que é seguro em modo memória/demo mas torna-se uma fonte de inconsistência (clobber + race no boot) assim que `STOCK_DRIVER=redis` for usado em produção/multi-instância. Recomenda-se guardar o seed por ambiente/driver (ou torná-lo idempotente) antes de qualquer uso real com Redis, e endereçar M1/M2 para boot mais rápido e fail-fast de configuração. Os LOW são cosméticos e podem ser agrupados num hardening posterior.
