# Code Review — src/application/ports/idempotency.port.ts

## Resumo

Port de idempotência pequeno, idiomático e bem documentado: token de DI via `Symbol`, DTO de retorno claro (`IdempotencyRecord`) e um único método `remember`. A aderência à arquitetura hexagonal é correta (zero dependência de infra; o domínio/aplicação depende da abstração). Os achados são todos sobre o **contrato**: o doc-comment promete "Redis SET NX EX" (detalhe de infra vazando na port), o TTL é tipado como `number` sem invariantes, e o contrato não especifica o comportamento de `remember` quando o valor lido de volta no replay difere do `orderId` passado — o que tem impacto real no caso de uso e nos dois adapters.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 0 |
| MEDIUM     | 2 |
| LOW        | 4 |

---

## MEDIUM

### M1 — O contrato de `remember` não especifica unidade/validade de `ttlMs`, e os adapters divergem no tratamento

- **Local:** linha 20 (`ttlMs: number`)
- **Descrição:** O parâmetro é tipado como `number` cru, sem nenhuma invariante documentada (positivo? milissegundos? o que acontece com `0`, negativo, `NaN` ou `Number.MAX_SAFE_INTEGER`?). A consequência é visível nos dois adapters: o `RedisIdempotencyAdapter` defensivamente faz `Math.max(1, ttlMs)` (redis-idempotency.adapter.ts:32), mas o `InMemoryIdempotencyAdapter` faz `now + ttlMs` sem nenhuma sanitização (in-memory-idempotency.adapter.ts:21). Com `ttlMs <= 0` o registro em memória nasce já expirado (`expiresAt <= now`), de modo que a próxima chamada com a mesma chave NÃO encontra o registro e retorna `created: true` de novo — quebrando a garantia central de "1 recurso por Idempotency-Key". Os dois adapters implementam contratos sutilmente diferentes a partir da mesma assinatura.
- **Impacto:** Comportamento de idempotência divergente entre dev (memória) e produção (Redis) para valores de borda de TTL; risco de double-order se a config injetar TTL não-positivo. Como o valor vem de `this.config.idempotencyTtlMs` (checkout.usecase.ts:88), hoje provavelmente é seguro, mas o contrato não impede regressão.
- **Correção sugerida:** Documentar a invariante no JSDoc e, idealmente, expressá-la com um tipo de marca (branded type) ou ao menos comentário normativo. Mínimo:
  ```ts
  /**
   * @param ttlMs janela de deduplicação em milissegundos. DEVE ser > 0.
   *   Implementações tratam valores <= 0 como 1ms (mínimo viável).
   */
  remember(key: string, orderId: string, ttlMs: number): Promise<IdempotencyRecord>;
  ```
  E alinhar o `InMemoryIdempotencyAdapter` ao `Math.max(1, ttlMs)` que o adapter Redis já aplica.

### M2 — O contrato não define o comportamento no replay quando o `orderId` armazenado difere do passado

- **Local:** linhas 14-20 (JSDoc de `remember`) e linhas 4-6 (`IdempotencyRecord.orderId`)
- **Descrição:** O doc diz "if it already exists, returns the existing orderId" (linha 17), mas o campo `IdempotencyRecord.orderId` (linha 4) não deixa explícito que, no caminho `created: true`, ele é o mesmo `orderId` que o chamador passou, e no `created: false` é o **valor armazenado** (potencialmente diferente). O caller depende disso: em checkout.usecase.ts:90 ele faz `this.orders.findById(rec.orderId)` esperando que `rec.orderId` seja o id da tentativa original, não o gerado nesta tentativa. Se o contrato não fixa isso, um adapter que devolvesse o `orderId` do argumento no replay (em vez do armazenado) levaria a um `findById` que falha e dispara `DuplicateRequestError` indevidamente. O `RedisIdempotencyAdapter` acerta (`existing ?? orderId`, linha 34) e o in-memory também (linha 19), mas é por convenção, não por contrato.
- **Impacto:** Ambiguidade contratual num ponto crítico de correção. Um novo adapter (ex.: DynamoDB) poderia satisfazer os tipos e ainda assim quebrar o fluxo de replay/409.
- **Correção sugerida:** Tornar o JSDoc do campo normativo:
  ```ts
  export interface IdempotencyRecord {
    /**
     * Quando created=true: o orderId reservado agora (== argumento passado).
     * Quando created=false: o orderId persistido pela tentativa ORIGINAL
     * (pode diferir do argumento; é este que o caller deve usar).
     */
    orderId: string;
    created: boolean;
  }
  ```

---

## LOW

### L1 — Detalhe de infraestrutura ("Redis SET NX EX / Map with lock") vaza no doc-comment da port

- **Local:** linha 18 (`Implementation: Redis SET NX EX / Map with lock.`)
- **Descrição:** A port é a fronteira da arquitetura hexagonal e deveria descrever apenas a *semântica* ("reserva atômica da chave"), não a tecnologia concreta. Citar Redis/Map acopla conceitualmente a abstração aos adapters e, ainda, a menção a "Map with lock" está desatualizada: o `InMemoryIdempotencyAdapter` não usa lock algum — ele se apoia na atomicidade do tick single-thread do Node (in-memory-idempotency.adapter.ts:8-11). Documentação que descreve um mecanismo inexistente induz a erro.
- **Impacto:** Pequeno acoplamento conceitual + comentário factualmente incorreto.
- **Correção sugerida:** Remover a linha "Implementation: ..." da port (ou substituí-la por "Atomicidade da reserva é responsabilidade do adapter"). O "como" já está documentado em cada adapter.

### L2 — Ausência de garantia explícita de idempotência da própria operação sob a mesma `(key, orderId)`

- **Local:** linhas 14-20
- **Descrição:** O contrato cobre `key` repetida com `orderId` diferente, mas não diz nada sobre o que acontece quando o mesmo chamador reexecuta `remember(key, MESMO_orderId, ttl)` (ex.: retry de rede após a 1ª chamada já ter persistido, mas antes da resposta chegar). Pelo comportamento dos adapters isso retorna `created: false` com o mesmo orderId — correto — mas o contrato deveria afirmá-lo para que seja uma garantia, não um efeito colateral.
- **Impacto:** Documentação; sem impacto runtime hoje.
- **Correção sugerida:** Acrescentar uma frase no JSDoc: "Chamadas repetidas com a mesma key são idempotentes; apenas a primeira retorna created: true."

### L3 — Tipos primitivos sem refinamento (`string` para `key` e `orderId`)

- **Local:** linha 20
- **Descrição:** `key` e `orderId` são `string` cruas. Não há nada que impeça inverter os argumentos na chamada (ambos `string`), e o contrato não documenta limites (tamanho máximo da key, charset). A key vem de um header HTTP controlado pelo cliente; embora a validação de entrada seja (corretamente) responsabilidade da borda HTTP, vale documentar que a port assume `key` já validada/normalizada, para não criar a falsa impressão de que a port sanitiza.
- **Impacto:** Manutenibilidade e clareza de responsabilidade; sem vulnerabilidade direta na port (a chave é usada como sufixo de chave Redis `idem:${key}` em redis-idempotency.adapter.ts:4 — uma key gigante e não-validada poderia inflar memória do Redis, mas a defesa cabe à borda).
- **Correção sugerida:** Documentar a pré-condição: "`key` DEVE estar previamente validada (tamanho/charset) pela camada de entrada; a port não a sanitiza." Opcionalmente, branded types (`OrderId`, `IdempotencyKey`) para evitar troca de argumentos.

### L4 — `IdempotencyRecord` não é `readonly`

- **Local:** linhas 3-7
- **Descrição:** Os campos do DTO de retorno são mutáveis. Sendo um value object de retorno, marcá-los `readonly` comunica imutabilidade e previne mutação acidental pelo consumidor.
- **Impacto:** Cosmético/robustez.
- **Correção sugerida:**
  ```ts
  export interface IdempotencyRecord {
    readonly orderId: string;
    readonly created: boolean;
  }
  ```

---

## Pontos positivos

- **Hexagonal correto:** zero import de infra; a port reside em `application/ports` e é consumida via token `Symbol` injetado (`@Inject(IDEMPOTENCY_PORT)` em checkout.usecase.ts:48). Inversão de dependência limpa.
- **Token via `Symbol`** evita colisão de strings em DI — idiomático e consistente com as demais ports (`STOCK_PORT`, etc.).
- **DTO mínimo e expressivo:** `created` como booleano de "novo vs replay" é mais claro e à prova de erro do que devolver `null`/sentinela.
- **Doc-comment do campo `created`** (linha 5) é preciso e útil ("true if this caller created the record now").
- **Superfície enxuta:** um único método coeso; nada de vazamento de responsabilidades (sem TTL refresh, sem delete, etc.), o que mantém os adapters simples e atômicos.
- **Assinatura assíncrona** (`Promise`) corretamente uniforme mesmo no adapter in-memory síncrono, preservando substituibilidade (LSP).

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está sólido como contrato e correto do ponto de vista arquitetural. Não há defeitos CRITICAL/HIGH no arquivo em si. As ressalvas são de **especificação de contrato**: documentar as invariantes de `ttlMs` (M1) e a semântica de `orderId` no replay (M2) — ambas hoje satisfeitas apenas por convenção dos adapters, não impostas pela port. Recomenda-se também remover a menção de infra desatualizada no JSDoc (L1, "Map with lock" não existe) e alinhar o `InMemoryIdempotencyAdapter` à sanitização de TTL que o adapter Redis já faz. Nenhuma dessas mudanças é bloqueante para merge, mas M1/M2 reduzem risco de regressão futura em novos adapters.
