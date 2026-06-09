# Code Review — src/infrastructure/idempotency/redis-idempotency.adapter.ts

## Resumo

Adapter Redis pequeno e bem-intencionado que implementa `IdempotencyPort.remember` via um script Lua atômico (`SET NX PX` + `GET` em um único round-trip), fechando corretamente a janela TOCTOU entre escrita e leitura. O núcleo de concorrência está sólido; os achados são de robustez de tipagem, validação de entrada e segurança operacional do `eval` — não há bug crítico de atomicidade.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 1          |
| MEDIUM     | 3          |
| LOW        | 4          |

---

## HIGH

### H1 — `eval` reenvia o corpo do script a cada chamada; sem `EVALSHA`/`defineCommand`, e sem proteção contra falha de carregamento
- **Local:** linhas 27-33 (`this.redis.eval(REMEMBER_LUA, 1, ...)`).
- **Descrição:** Cada `remember` envia o texto completo do script Lua pela rede e força o Redis a recompilá-lo/cacheá-lo a cada chamada. No caminho quente de checkout (uma chamada por request), isso desperdiça banda e CPU do Redis. O idiomático com ioredis é `redis.defineCommand('idemRemember', { numberOfKeys: 1, lua: REMEMBER_LUA })`, que usa `EVALSHA` com fallback automático para `EVAL` no `NOSCRIPT`.
- **Impacto:** Overhead por request no caminho mais sensível a latência do sistema (checkout). Em alto volume é uma penalidade mensurável e desnecessária; também aumenta a superfície de variação de latência sob carga.
- **Correção sugerida:** Definir o comando uma vez (idealmente em `OnModuleInit` ou no construtor) e chamá-lo por nome:
  ```ts
  constructor(private readonly redis: Redis) {
    this.redis.defineCommand('idemRemember', { numberOfKeys: 1, lua: REMEMBER_LUA });
  }
  // ...
  const [created, existing] = (await (this.redis as any).idemRemember(
    KEY(key), orderId, String(Math.max(1, Math.floor(ttlMs))),
  )) as [number, string | null];
  ```
  Alternativamente, manter `eval` mas medir; o ganho do `EVALSHA` é real sob carga.

---

## MEDIUM

### M1 — `ttlMs` não-inteiro/`NaN`/`Infinity` produz argumento `PX` inválido e quebra o comando em runtime
- **Local:** linha 32 (`String(Math.max(1, ttlMs))`).
- **Descrição:** `Math.max(1, ttlMs)` protege contra valores `<= 1`, mas não contra **fracionários** nem contra `NaN`/`Infinity`. Se `ttlMs` for `1500.7`, o `PX` recebe `"1500.7"`, que o Redis rejeita (`value is not an integer or out of range`). Se `ttlMs` for `NaN`, `Math.max(1, NaN)` é `NaN` → `"NaN"`, também rejeitado, e a exceção sobe quebrando o checkout inteiro. O valor vem de `config.idempotencyTtlMs` (linha 88 do use case), normalmente inteiro, mas o adapter é a fronteira de infra e deveria blindar a entrada.
- **Impacto:** Um TTL configurado incorretamente (ou derivado por cálculo) derruba todas as requests de checkout com erro do Redis, não com um fallback gracioso. Falha total em vez de degradação.
- **Correção sugerida:** Normalizar para inteiro positivo finito:
  ```ts
  const px = Math.max(1, Math.floor(Number.isFinite(ttlMs) ? ttlMs : 1));
  // ... String(px)
  ```

### M2 — `key` e `orderId` não são validados; chave/valor vazios ou gigantes passam direto
- **Local:** linhas 26-33; helper `KEY` na linha 4.
- **Descrição:** Não há validação de `key` (`''`, espaços, tamanho) nem de `orderId`. Uma `key` vazia gera a chave Redis `idem:`, colidindo todas as requests sem Idempotency-Key em um único slot. Embora o use case gere uma chave quando ausente (linhas 78-85), o adapter — sendo a fronteira de infra — não deveria confiar nisso; é um invariante implícito não enforçado. Não há injeção clássica (Lua usa `KEYS`/`ARGV` parametrizados, então **não** há Lua/command injection — ponto positivo), mas a ausência de bound de tamanho permite chaves/valores arbitrariamente grandes ocupando memória do Redis.
- **Impacto:** Risco de colisão lógica (uma `key` vazia compartilhada) e de consumo de memória não-limitado. Correção de robustez/segurança defensiva.
- **Correção sugerida:** Validar no início do método: rejeitar `key`/`orderId` vazios após `trim`, e opcionalmente limitar comprimento, lançando um erro de domínio claro (ex.: `InvalidIdempotencyKeyError`) em vez de gerar uma chave silenciosamente válida.

### M3 — Erros do Redis propagam crus, sem contexto nem tipagem de domínio
- **Local:** linhas 27-33 (sem `try/catch`).
- **Descrição:** Qualquer falha do Redis (conexão caída, `NOSCRIPT`, OOM, timeout) sobe como erro bruto do ioredis. Não há enriquecimento de contexto (qual `key`), nem mapeamento para um erro de aplicação, nem decisão explícita de política (fail-open vs fail-closed). Para idempotência o correto é **fail-closed** (não criar pedido se não consigo garantir dedupe), e isso de fato acontece por propagação — mas é um efeito colateral, não uma decisão documentada/testada.
- **Impacto:** Diagnóstico mais difícil em produção (stack genérico do driver) e acoplamento do caller a tipos de erro de infra. Para um sistema com observabilidade declarada (OTel/Prometheus), faltam atributos/contadores nesse ponto.
- **Correção sugerida:** Envolver em `try/catch`, registrar/contar a falha (métrica `idempotency_remember_errors_total`) e relançar como erro de aplicação preservando a `cause`:
  ```ts
  } catch (err) {
    throw new IdempotencyStoreError(`remember failed for key`, { cause: err });
  }
  ```
  Manter a semântica fail-closed e cobri-la com teste.

---

## LOW

### L1 — Asserção de tipo dupla insegura sobre o retorno de `eval`
- **Local:** linhas 27-33 (`(await this.redis.eval(...)) as [number, string | null]`).
- **Descrição:** `eval` retorna `unknown`; o cast assume cegamente a forma `[number, string | null]`. Se o script ou a versão do Redis mudar a forma do retorno, o erro só aparece em runtime (ou pior, silenciosamente como `undefined`). Não há validação da forma decodificada.
- **Impacto:** Fragilidade de tipo; o compilador não protege contra divergência script↔TS.
- **Correção sugerida:** Após receber, validar minimamente (`Array.isArray(res) && res.length === 2`) antes de desestruturar, ou tipar via `defineCommand` (M1/H1) que dá uma assinatura mais controlada.

### L2 — Status reply do `SET NX` em Lua é truthy de forma não-óbvia; merece comentário
- **Local:** linhas 13-15 (script Lua).
- **Descrição:** `redis.call('SET', ..., 'NX')` retorna o status `OK` (que em Lua vira a tabela `{ok="OK"}`, truthy) quando cria, e `false`/`nil` quando a chave já existe. O código `if created then` está **correto**, mas depende de um detalhe sutil do protocolo Lua-Redis que não está comentado. Um leitor futuro pode "corrigir" para `if created == 'OK'` (que falharia, pois é tabela) ou `if created ~= nil`.
- **Impacto:** Risco de regressão por manutenção. Comportamento correto hoje.
- **Correção sugerida:** Adicionar comentário no script explicando que `SET NX` retorna status truthy `{ok="OK"}` no sucesso e `false` quando não cria.

### L3 — `created === 1` depende da coerção número Lua→JS; robusto, mas frágil a refactor
- **Local:** linha 34 (`created: created === 1`).
- **Descrição:** O script retorna inteiros `1`/`0`; ioredis os entrega como `number`. A comparação estrita está correta. Porém, combinada com L1 (cast cego), se o retorno vier como string `"1"` (não é o caso hoje, mas possível com mudança de driver/serialização), `created` viraria `false` silenciosamente — uma falha de idempotência sem erro visível.
- **Impacto:** Modo de falha silencioso teórico, dependente de mudanças futuras.
- **Correção sugerida:** Usar `Number(created) === 1` para tolerar coerção, ou validar a forma (L1).

### L4 — Falta `OnModuleInit`/lifecycle e o adapter não participa do scope/health do módulo
- **Local:** classe inteira (linhas 23-36); wiring em `infrastructure.module.ts:52-59`.
- **Descrição:** O adapter recebe `Redis` já construído via `useFactory` (correto para hexagonal — sem vazamento de infra no domínio, ponto positivo). Mas não implementa nenhum lifecycle (`OnModuleInit`) onde caberia o `defineCommand` (H1) e uma checagem de conectividade/`ping`. Sem `@Injectable()` na classe (é instanciada manualmente no factory, então funciona), o que é aceitável, mas deixa o adapter sem hooks de ciclo de vida do Nest.
- **Impacto:** Oportunidade perdida de inicialização única (script) e de health-check; não é bug.
- **Correção sugerida:** Se adotar `defineCommand`, implementar `OnModuleInit` na classe e registrar o comando lá; opcionalmente expor um `ping`/health para o readiness probe.

---

## Pontos positivos

- **Atomicidade correta:** o script Lua executa `SET NX PX` + `GET` atomicamente no servidor, eliminando de fato a janela TOCTOU descrita no comentário (linhas 6-16). Decisão de design certa e bem documentada.
- **Sem injeção:** `KEYS`/`ARGV` são parametrizados; não há interpolação de input no corpo do script — imune a Lua/command injection.
- **Hexagonal limpo:** implementa `IdempotencyPort` (porta em `application/ports`), recebe `Redis` por construtor via `useFactory`, zero acoplamento do domínio à infra. Inversão de dependência correta.
- **Guard de TTL mínimo:** `Math.max(1, ttlMs)` evita `PX 0`/negativo (apesar de M1 sobre fracionários/NaN).
- **Semântica de retorno coerente** com o `InMemoryIdempotencyAdapter` irmão: `{ orderId: existing ?? orderId, created }`, garantindo paridade entre drivers.
- **Tamanho e foco:** classe coesa, responsabilidade única, fácil de testar.

---

## Veredito

**Aprovado com ressalvas.**

O coração de concorrência/atomicidade está correto e a aderência hexagonal é exemplar. Nenhum bug crítico. Recomenda-se, antes de produção de alto volume: (1) adotar `defineCommand`/`EVALSHA` no caminho quente [H1]; (2) normalizar `ttlMs` para inteiro finito [M1]; (3) validar `key`/`orderId` na fronteira [M2]; (4) envolver o `eval` com tratamento de erro fail-closed + observabilidade [M3]. Os achados LOW são endurecimento de manutenção.
