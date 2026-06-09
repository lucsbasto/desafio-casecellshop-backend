# Code Review — src/infrastructure/config/app-config.ts

## Resumo

Arquivo de configuração centralizada e tipada, lendo variáveis de ambiente com defaults seguros. O design é limpo, coeso e idiomático para hexagonal (a infra produz um objeto `AppConfig` consumido via porta/symbol `APP_CONFIG`). Não há bugs críticos, mas há lacunas relevantes de **validação de invariantes** (faixas numéricas, coerência min/max, ausência de fail-fast) que podem produzir comportamento incorreto silencioso em runtime (estoque/ERP/reconcile/filas) e um ponto de duplicação de carga em `main.ts`.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 2 |
| MEDIUM     | 4 |
| LOW        | 4 |

---

## HIGH

### H1 — Ausência de validação de invariantes numéricas (faixas e coerência min/max)
- **Local:** `num()` (linhas 7-11) e todo o `loadConfig()` (35-66), em especial `erp.minLatencyMs/maxLatencyMs` (58-59), `reconcile.ageMs/maxAgeMs` (62-63), `erp.failRate` (57).
- **Descrição:** `num()` apenas garante que o valor é um número finito; aceita negativos, zero onde não faz sentido, e não valida relações entre campos. Exemplos de configurações aceitas mas semanticamente inválidas:
  - `ERP_FAIL_RATE` fora de `[0,1]` (ex.: `2` ⇒ ERP sempre falha; `-1` ⇒ nunca falha). O consumidor `fake-erp.client.ts:42` faz `random() < failRate` sem clamp.
  - `ERP_MIN_LATENCY_MS > ERP_MAX_LATENCY_MS`: em `fake-erp.client.ts:38` `span = max - min` fica negativo; há `Math.max(0, span)`, mas o resultado é latência fixa no `min` (maior que o `max` pretendido) — invariante violada silenciosamente.
  - `RECONCILE_AGE_MS > RECONCILE_MAX_AGE_MS`: em `reconcile.usecase.ts:33-34`, `ageCutoff` ficaria mais antigo que `maxAgeCutoff`, invertendo a lógica de "requeue vs. falha definitiva" e podendo falhar pedidos que deveriam ser apenas reenfileirados.
  - `PORT` negativa/`0`/`> 65535` ⇒ erro só no `app.listen()`.
  - `WORKER_MAX_ATTEMPTS = 0` ou negativo ⇒ em `bullmq-queue.adapter.ts:52` (`attempts`) e `in-memory-queue.adapter.ts:60` comportamento degenerado de retries.
- **Impacto:** Falha silenciosa de configuração. Em e-commerce com estoque/idempotência/filas, uma env var malformada não derruba o boot — ela corrompe o comportamento (latência, taxa de falha simulada, ordem de reconciliação, número de tentativas), o que é muito mais difícil de diagnosticar do que um crash no startup.
- **Correção sugerida:** Validar no `loadConfig()` com fail-fast (idealmente via `zod`/`class-validator`, ou validação manual). Mínimo viável:
  ```ts
  function numInRange(key: string, def: number, min: number, max: number): number {
    const n = num(key, def);
    if (n < min || n > max) {
      throw new Error(`Config ${key}=${n} fora da faixa [${min}, ${max}]`);
    }
    return n;
  }
  // ...
  failRate: numInRange('ERP_FAIL_RATE', 0.3, 0, 1),
  // e após montar o objeto, validar coerência:
  if (cfg.erp.minLatencyMs > cfg.erp.maxLatencyMs) throw new Error('ERP_MIN_LATENCY_MS > ERP_MAX_LATENCY_MS');
  if (cfg.reconcile.ageMs > cfg.reconcile.maxAgeMs) throw new Error('RECONCILE_AGE_MS > RECONCILE_MAX_AGE_MS');
  ```
  Preferir `zod` para um schema único, tipado e com mensagens claras.

### H2 — `driver()` silencia valores inválidos (default oculto para `memory`)
- **Local:** `driver()` linhas 12-14.
- **Descrição:** `driver()` retorna `'redis'` apenas se o valor for exatamente `'redis'`; **qualquer outra coisa** (inclusive um typo como `'redys'`, `'Redis'`, `'REDIS'`, ou um valor inesperado) cai silenciosamente em `'memory'`. Em produção, definir `STOCK_DRIVER=Redis` (maiúsculo) faria o sistema rodar com estoque em memória — perdendo atomicidade/persistência sem nenhum aviso.
- **Impacto:** Risco operacional alto: a diferença entre `redis` e `memory` para `stock`/`idempotency` é a diferença entre garantias de atomicidade/durabilidade e a ausência delas. Um erro de digitação degrada silenciosamente as garantias de consistência do checkout.
- **Correção sugerida:** Validar contra o conjunto permitido e falhar (ou ao menos logar warning) em valor desconhecido:
  ```ts
  function driver(key: string, def: Driver): Driver {
    const raw = str(key, def).toLowerCase();
    if (raw !== 'redis' && raw !== 'memory') {
      throw new Error(`Config ${key}='${raw}' inválido (esperado 'redis' | 'memory')`);
    }
    return raw;
  }
  ```

---

## MEDIUM

### M1 — `loadConfig()` é chamado duas vezes (DI + main.ts), sem garantia de coerência
- **Local:** este arquivo (factory `loadConfig`) consumido em `infrastructure.module.ts:32` (`useFactory: loadConfig`) e **novamente** em `main.ts:12` (`const config = loadConfig()`).
- **Descrição:** Há duas instâncias de configuração: a do container DI (`APP_CONFIG`) e uma local no bootstrap, usada para `app.listen(config.port)`. Embora a função seja determinística sobre `process.env`, isso duplica leitura e abre espaço para divergência se algo mutar `process.env` entre as chamadas, e desperdiça a validação fail-fast centralizada (se adicionada em H1, ela rodaria duas vezes).
- **Impacto:** Manutenibilidade e princípio de fonte única de verdade. Baixo risco funcional hoje, mas é um anti-padrão (a config deveria vir do container).
- **Correção sugerida:** No `main.ts`, obter a config do container: `const config = app.get<AppConfig>(APP_CONFIG);` em vez de chamar `loadConfig()` de novo.

### M2 — `num()` aceita `NaN`/`Infinity` textuais e perde sinal de erro de configuração
- **Local:** `num()` linhas 7-11.
- **Descrição:** `Number('  ')` → `0`, `Number('0x10')` → `16`, `Number('1e3')` → `1000`, `Number('Infinity')` → `Infinity` (rejeitado por `isFinite`, cai no default — silenciosamente). O comportamento mais problemático: um valor **presente mas malformado** (ex.: `PORT=abc`) não gera erro; cai no default `3000` sem qualquer log. O operador acredita ter configurado a porta 8080 (digitou `808O`) e o serviço sobe em 3000.
- **Impacto:** Falha silenciosa de configuração; debugging difícil em produção.
- **Correção sugerida:** Distinguir "ausente" (usa default) de "presente e inválido" (erro/warn):
  ```ts
  function num(key: string, def: number): number {
    const v = process.env[key];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Config ${key}='${v}' não é um número válido`);
    return n;
  }
  ```

### M3 — `idempotencyTtlMs` default (86400000 = 24h) é "número mágico" sem unidade explícita
- **Local:** linha 65.
- **Descrição:** `86400000` é o único literal grande sem comentário de unidade. Embora o sufixo `Ms` no nome ajude, é fácil errar ao manter. O TTL de idempotência governa por quanto tempo uma chave de checkout impede reprocessamento (`checkout.usecase.ts:88`), então um erro aqui tem consequência direta em duplicação de pedidos.
- **Impacto:** Manutenibilidade; risco indireto de duplicidade/replay se mal configurado.
- **Correção sugerida:** Tornar a unidade explícita: `idempotencyTtlMs: num('IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000)` com comentário, ou validar `> 0`.

### M4 — `redisUrl` não é validado mesmo quando algum driver é `redis`
- **Local:** `redisUrl` linha 47; relação com `drivers.*` (41-46).
- **Descrição:** Não há checagem de coerência: se qualquer driver é `redis`, `REDIS_URL` deveria ser uma URL válida e presente. O default `redis://localhost:6379` mascara ausência — em produção, esquecer `REDIS_URL` faz o app tentar conectar em localhost silenciosamente (a falha aparece só no `redis.provider.ts`, mais tarde, possivelmente como erro de conexão obscuro).
- **Impacto:** Configuração incorreta detectada tarde; em produção pode significar app conectando ao Redis errado ou inexistente.
- **Correção sugerida:** Quando `anyRedisDriver(cfg)` for verdadeiro (lógica já existe em `redis.provider.ts:7`), exigir `REDIS_URL` explícita e validar o formato (`new URL(redisUrl)`), falhando no boot.

---

## LOW

### L1 — Ausência de teste unitário para `loadConfig()`
- **Local:** arquivo inteiro (não existe `app-config.spec.ts`).
- **Descrição:** A lógica de parsing/coerção (`num`, `driver`, defaults) não tem cobertura. Os helpers têm exatamente o tipo de edge case (NaN, ausência, valor inválido) que se beneficia de testes.
- **Impacto:** Regressões silenciosas em mudanças futuras de parsing.
- **Correção sugerida:** Adicionar `app-config.spec.ts` cobrindo: default quando env ausente, parsing válido, fallback em valor inválido, e (após H1/H2) os erros de validação.

### L2 — `str()` não trata string vazia como ausente
- **Local:** `str()` linhas 4-6.
- **Descrição:** `process.env[key] ?? def` usa `??`, que só cai no default para `undefined`/`null`. Uma env var **definida como vazia** (`SERVICE_NAME=`) retorna `''`, não o default. Em Docker/compose é comum exportar variáveis vazias acidentalmente. Isso afeta `serviceName`/`logLevel` (telemetria/observabilidade) e indiretamente `driver()` (string vazia → `memory`).
- **Impacto:** Baixo, mas pode degradar labels de observabilidade (OTel/Prometheus) silenciosamente.
- **Correção sugerida:** Tratar vazio como ausente onde fizer sentido: `const v = process.env[key]; return v ? v : def;` (ou normalizar/trim).

### L3 — `logLevel` e `env` tipados como `string` livre, sem união literal
- **Local:** `AppConfig.env` (18), `AppConfig.logLevel` (20); produção em `loadConfig` (38, 40).
- **Descrição:** `env` e `logLevel` aceitam qualquer string. `logLevel` é repassado ao pino (`app.module.ts:20`); um valor inválido (`LOG_LEVEL=verbose`) pode ser ignorado ou quebrar o logger. `env` poderia ser uma união (`'development' | 'production' | 'test'`).
- **Impacto:** Tipagem mais fraca do que poderia; erros de configuração não detectados em tempo de tipo.
- **Correção sugerida:** Usar uniões literais (`type LogLevel = 'fatal'|'error'|'warn'|'info'|'debug'|'trace'`) e validar no parsing.

### L4 — Acoplamento direto a `process.env` dificulta testes e isolamento
- **Local:** `str`/`num` (4-11) leem `process.env` diretamente.
- **Descrição:** A leitura global de `process.env` dentro das funções torna o módulo dependente de estado global, dificultando testes determinísticos (precisa mutar `process.env`). Não é um problema arquitetural grave (config é fronteira de infra, é aceitável tocar env aqui), mas injetar a fonte (`env = process.env`) facilitaria testes.
- **Impacto:** Testabilidade.
- **Correção sugerida:** Opcional — parametrizar a fonte: `function loadConfig(env: NodeJS.ProcessEnv = process.env)` e propagar aos helpers, permitindo testar sem mutar o global.

---

## Pontos positivos

- **Tipagem central e clara:** `AppConfig` é uma interface coesa e bem estruturada; o agrupamento por domínio (`drivers`, `cache`, `worker`, `erp`, `reconcile`) é excelente para legibilidade.
- **Aderência hexagonal:** a config é infra pura, exposta via symbol `APP_CONFIG` e consumida por DI nos use cases/adapters sem vazar `process.env` para o domínio. Correto.
- **Defaults seguros por padrão:** drivers default `memory` evita dependência obrigatória de Redis em dev/test — boa decisão de DX (ressalva: ver H2 sobre silenciar erros).
- **`num()` robusto contra `NaN`:** usa `Number.isFinite`, evitando que `NaN` se propague como valor numérico (melhor que `parseInt` ingênuo).
- **Idiomatismo NestJS:** symbol como token de DI (em vez de string) é a prática recomendada e evita colisões.
- **Sem secrets hardcoded** e sem exposição de dados sensíveis no arquivo.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é sólido em estrutura e aderência arquitetural, sem bugs críticos. As ressalvas concentram-se em **validação de invariantes de configuração** (H1, H2) e **fail-fast no boot**: num sistema de checkout com estoque/idempotência/filas, configurações malformadas devem falhar ruidosamente no startup, não degradar garantias silenciosamente em runtime. Recomenda-se endereçar H1 e H2 antes de produção (idealmente migrando para um schema `zod`), e corrigir M1 (dupla carga) por higiene. Os itens MEDIUM/LOW restantes são melhorias incrementais de robustez e testabilidade.
