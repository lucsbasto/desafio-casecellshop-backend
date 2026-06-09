# Code Review — src/infrastructure/redis.provider.ts

## Resumo

O arquivo é pequeno, idiomático e bem estruturado: factory provider que cria a conexão `ioredis` somente quando algum driver está em modo `redis`, retornando `null` no modo memória, mais um `RedisLifecycle` para fechar a conexão no shutdown. A lógica está correta para o caso feliz; os achados são de robustez operacional (shutdown, observabilidade de reconexão, opções de conexão BullMQ-safe) e não de bugs funcionais bloqueantes.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 1         |
| MEDIUM     | 3         |
| LOW        | 4         |

---

## HIGH

### H1 — `client.quit()` pode travar ou rejeitar o shutdown; falta fallback para `disconnect()`
- **Local:** linha 39 (`if (this.client) await this.client.quit();`)
- **Descrição:** `quit()` envia o comando `QUIT` e aguarda a resposta do servidor. Se o Redis estiver indisponível, em reconexão, ou com comandos pendentes na fila, a promise pode rejeitar (ex.: `Connection is closed`) ou demorar. Como `maxRetriesPerRequest: null` (linha 22) faz comandos esperarem indefinidamente por reconexão, um `QUIT` enfileirado durante um outage pode nunca resolver. Uma rejeição não tratada em `onModuleDestroy` propaga e pode abortar a sequência de shutdown do Nest, deixando outros hooks (ex.: fechar fila BullMQ) sem executar.
- **Impacto:** Shutdown não-determinístico/travado em produção, justamente em cenário de falha do Redis — o pior momento. Também contradiz o objetivo declarado no docblock ("exit cleanly / Jest não reclama de handles abertos").
- **Correção sugerida:** Envolver em try/catch e cair para `disconnect()` (que é síncrono e força o fechamento do socket), garantindo que o hook sempre termine:
  ```ts
  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch (err) {
      this.logger.warn(`quit() falhou, forçando disconnect: ${(err as Error).message}`);
      this.client.disconnect();
    }
  }
  ```
  (requer adicionar `private readonly logger = new Logger(RedisLifecycle.name);`).

---

## MEDIUM

### M1 — Sem timeout/limite de conexão: factory + comandos podem pendurar indefinidamente
- **Local:** linha 22 (`new IORedis(config.redisUrl, { maxRetriesPerRequest: null })`)
- **Descrição:** Com `maxRetriesPerRequest: null` e sem `connectTimeout` nem `enableOfflineQueue`/`commandTimeout` explícitos, qualquer comando emitido enquanto o Redis está fora fica enfileirado indefinidamente. Isso é exigido pelo BullMQ, mas este client também alimenta Cache/Stock/Idempotency (ver `infrastructure.module.ts`). Um Redis lento/indisponível faz requisições HTTP de checkout pendurarem sem timeout em vez de falharem rápido.
- **Impacto:** Risco de esgotamento de conexões/threads do event loop e p99 degradado sob falha parcial do Redis, sem circuit-breaking. Afeta diretamente o fluxo de checkout (estoque/idempotência).
- **Correção sugerida:** Definir `connectTimeout` (ex.: 10000) e considerar `commandTimeout` para os usos não-BullMQ, ou separar a conexão BullMQ (que já é criada à parte no `QueueProvider`) da conexão de cache/stock/idempotência, aplicando `commandTimeout` apenas nesta última.

### M2 — `redisUrl` não é validado; credenciais/URL malformada só falham em runtime
- **Local:** linha 22 (uso direto de `config.redisUrl`)
- **Descrição:** `redisUrl` vem de `str('REDIS_URL', 'redis://localhost:6379')` sem validação de formato. Uma URL inválida ou esquema errado só produz erro assíncrono no evento `error`, sem falhar o boot. Como o provider retorna o client imediatamente (não aguarda `connect`), a aplicação sobe "saudável" mesmo com Redis inalcançável, e as falhas aparecem só no primeiro comando.
- **Impacto:** Boot aparentemente OK com dependência crítica quebrada (fail-silent na inicialização). Dificulta detecção em readiness/deploy.
- **Correção sugerida:** Validar o esquema (`redis://` / `rediss://`) na config, ou adicionar um health/readiness check que faça `PING`. No mínimo, logar em nível `warn` se a primeira conexão não ocorrer dentro de um prazo.

### M3 — Conexão não é compartilhada via `lazyConnect`/health, e reconexões não são observáveis
- **Local:** linhas 23-24 (apenas handlers `error` e `connect`)
- **Descrição:** Não há listeners para `reconnecting`, `close` e `end`. Em produção, perder a conexão e reconectar passa despercebido nos logs; só o primeiro `connect` e erros pontuais aparecem. Para um serviço de checkout dependente de estoque/idempotência em Redis, a ausência de visibilidade sobre o estado da conexão prejudica diagnóstico de incidentes.
- **Impacto:** Observabilidade insuficiente em um componente de infraestrutura crítico; o projeto declara foco em OpenTelemetry/Prometheus, mas o estado da conexão Redis não é exposto.
- **Correção sugerida:** Adicionar handlers `reconnecting`/`close`/`end` em nível `warn`, e idealmente uma métrica/gauge de estado da conexão para o Prometheus.

---

## LOW

### L1 — `connect` loga a `redisUrl` completa, podendo vazar credenciais
- **Local:** linha 24 (`Conectado ao Redis em ${config.redisUrl}`)
- **Descrição:** Se `REDIS_URL` contiver credenciais (`redis://user:senha@host:6379`), elas vão para os logs em texto claro a cada conexão/reconexão.
- **Impacto:** Exposição de secret em logs (baixo aqui pois o default é local sem credenciais, mas vira HIGH em ambiente real com auth).
- **Correção sugerida:** Logar apenas host:porta, mascarando credenciais — ex.: `new URL(config.redisUrl).host`, ou redigir a senha antes de logar.

### L2 — `error` handler descarta o stack/erro original (`err.message` apenas)
- **Local:** linha 23 (`logger.error(\`Redis: ${err.message}\`)`)
- **Descrição:** Apenas a mensagem é logada; o objeto `Error` (com stack e código, ex.: `ECONNREFUSED`) é perdido. O `Logger.error` do Nest aceita um segundo argumento de trace.
- **Impacto:** Diagnóstico mais difícil; perda de `err.code`/stack.
- **Correção sugerida:** `logger.error(\`Redis: ${err.message}\`, err.stack);` ou passar o erro completo.

### L3 — Logger recriado dentro da factory; poderia ser constante de módulo
- **Local:** linha 21 (`const logger = new Logger('RedisProvider')` dentro do `useFactory`)
- **Descrição:** Menor; a factory roda uma vez, então não há custo real, mas a string `'RedisProvider'` solta foge ao padrão `ClassName.name` usado em `RedisLifecycle`/`StockSeeder`. Consistência.
- **Impacto:** Cosmético/manutenção.
- **Correção sugerida:** Extrair `const logger = new Logger(RedisProvider.name ?? 'RedisProvider')` não se aplica a objeto literal; usar uma constante `const LOGGER_CTX = 'RedisProvider'` compartilhada ou manter, apenas garantindo consistência de contexto.

### L4 — `anyRedisDriver` cobre drivers além dos que usam este client (acoplamento sutil)
- **Local:** linhas 7-9
- **Descrição:** `anyRedisDriver` retorna `true` se *qualquer* driver for `redis`, incluindo `queue`. Porém o `QueueProvider` (BullMQ) cria sua própria conexão a partir de `redisUrl` e não consome `REDIS_CLIENT`. Assim, com apenas `QUEUE_DRIVER=redis`, este provider cria uma conexão `ioredis` ociosa que ninguém usa (a não ser para manter o handle aberto até o shutdown).
- **Impacto:** Conexão Redis desnecessária aberta em uma configuração válida; desperdício de recurso e ruído de log. Não é bug funcional.
- **Correção sugerida:** Restringir a checagem aos drivers que realmente consomem o client compartilhado (`cache`, `stock`, `idempotency`), ou documentar explicitamente que `queue=redis` também aciona o client compartilhado por design.

---

## Pontos positivos

- Modo memória sem dependência de Redis (`null`) é bem pensado e permite rodar sem Docker — ótimo para DX/testes.
- Contrato `Redis | null` é honrado pelos consumidores via `requireRedis` em `infrastructure.module.ts`, com mensagem de erro clara.
- `maxRetriesPerRequest: null` corretamente aplicado e documentado como requisito do BullMQ.
- `RedisLifecycle` separado e idempotente (`if (this.client)`), com docblock explicando a necessidade de `enableShutdownHooks()`.
- Uso de `Symbol` para o token de DI evita colisões — idiomático e seguro.
- Docblocks claros e em linha com a arquitetura hexagonal (infra isolada, sem vazamento para o domínio).

---

## Veredito

**Aprovado com ressalvas.** Não há defeito funcional crítico e o código está alinhado à arquitetura. Recomenda-se endereçar antes de produção: H1 (robustez do shutdown com fallback `disconnect()`), M1 (timeouts de conexão/comando para o caminho não-BullMQ) e L1 (mascarar credenciais no log). Os demais (M2, M3, L2-L4) são melhorias de observabilidade e higiene recomendadas.
