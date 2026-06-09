# Code Review — src/application/use-cases/checkout.usecase.ts

## Resumo

O caso de uso está bem estruturado, respeita a arquitetura hexagonal (depende só de portas) e implementa corretamente a ordem anti-ghost-order (idempotência → reserva atômica → save PENDING → enqueue). O ponto mais sério é uma janela de indisponibilidade quando a chave de idempotência é reivindicada mas a persistência do pedido falha: o cliente legítimo fica travado em 409 até o TTL expirar. Há também tratamento frágil na compensação de estoque e falta de deduplicação de `productId`.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 2 |
| MEDIUM     | 3 |
| LOW        | 4 |

---

## HIGH

### H1 — Janela de "chave fantasma": cliente legítimo travado em 409 até o TTL
**Local:** linhas 88–97 (interação com 99–125 e 140).

**Descrição:** `idempotency.remember` reivindica a chave atomicamente e grava `orderId` ANTES de qualquer reserva ou `orders.save`. Se, após `created: true`, o processo falhar entre a linha 88 e o `orders.save` (linha 140) — exceção de estoque que escapa, crash do processo, timeout, deploy/restart, falha de rede no repositório — a chave fica gravada apontando para um `orderId` que nunca foi persistido. No retry com a mesma `Idempotency-Key`, o fluxo entra em `!rec.created`, faz `findById(rec.orderId)` → `undefined` → lança `DuplicateRequestError` (409).

Resultado: o cliente que fez tudo certo e só recebeu um erro transitório fica **permanentemente bloqueado** de concluir aquele checkout até o `idempotencyTtlMs` expirar (60s no default, mas configurável para muito mais). Idempotency-Key existe justamente para tornar o retry seguro; aqui ela transforma uma falha transitória em falha definitiva.

Observação: o caso de `InsufficientStockError` é legítimo permanecer 409 (não há estoque), mas o de falha transitória (crash/timeout no save) não deveria. O código não distingue os dois.

**Impacto:** Disponibilidade. Em produção, qualquer falha transitória durante o checkout converte-se em erro irrecuperable por até TTL segundos para aquele cliente, exatamente o oposto do que idempotência promete.

**Correção sugerida:** Tratar a reivindicação de chave como reserva *provisória* e liberá-la quando a tentativa falha antes de persistir o pedido. Opções:
- No `catch` da reserva (linha 119) e ao redor do `orders.save`/`enqueue`, se a tentativa falhar antes de o pedido existir, chamar um `idempotency.forget(key)` (novo método de porta) para liberar a chave, permitindo retry limpo.
- OU diferenciar no replay: se `findById` retorna `undefined` e a falha original foi transitória, permitir re-claim em vez de 409 cego. A semântica atual (409 `DUPLICATE_REQUEST`) só faz sentido se a chave nunca for liberada em falha transitória.

```ts
} catch (err) {
  for (const r of reserved) {
    await this.safeRelease(r.productId, r.quantity);
  }
  // Libera a chave: a tentativa falhou antes de persistir o pedido,
  // então o retro com a mesma key deve poder recomeçar (não 409 eterno).
  await this.idempotency.forget(key).catch(() => undefined);
  throw err;
}
```

---

### H2 — Erro na compensação mascara o erro original e deixa reserva parcial
**Local:** linhas 119–125.

**Descrição:** No bloco de compensação, `await this.stock.release(...)` é chamado em loop sem proteção. Se o `release` de um item lançar (Redis indisponível, etc.), a exceção do `release` **substitui** o `InsufficientStockError`/`ProductNotFoundError` original (perda de stack e de semântica → o `execute` na linha 68 vai classificar errado a métrica e o controller vai mapear o status HTTP errado). Pior: o loop aborta no primeiro `release` que falha, deixando os itens restantes de `reserved` ainda reservados — **vazamento de estoque** (oversell ao contrário: estoque preso).

**Impacto:** Observabilidade incorreta (métrica `outcome` e status HTTP errados) e estoque reservado preso até reconciliação (se houver). A causa raiz real (ex.: sem estoque) fica escondida atrás de um erro de infra.

**Correção sugerida:** Isolar cada `release`, nunca deixar a compensação derrubar o erro de negócio:

```ts
} catch (err) {
  await Promise.allSettled(
    reserved.map((r) => this.stock.release(r.productId, r.quantity)),
  ).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger.error('Falha ao compensar reserva de estoque', r.reason);
      }
    }
  });
  throw err; // preserva sempre o erro original
}
```

---

## MEDIUM

### M1 — `productId` duplicado nos itens: lookups redundantes e itens duplicados no pedido
**Local:** linhas 103–118, 131; DTO em `checkout.dto.ts` (sem `@ArrayUnique`/dedupe).

**Descrição:** O DTO valida formato e tamanho de `items` (até 50), mas não impede o mesmo `productId` repetido. Se o cliente enviar `[{CAPA-001, 1}, {CAPA-001, 1}]`, o use case faz `findById` duas vezes (N+1 desnecessário) e duas reservas separadas. O total fica correto, mas `order.items` (linha 131) persiste a lista crua com duplicatas, e a reserva é fragmentada (duas operações atômicas em vez de uma de quantidade somada), o que muda a semântica de compensação.

**Impacto:** Desperdício de chamadas ao "ERP fake" e ao Redis; itens duplicados no read model. Em cenários de oversell parcial concorrente, duas reservas separadas para o mesmo produto têm comportamento mais difícil de raciocinar do que uma agregada.

**Correção sugerida:** Agregar itens por `productId` no início do `run` (ou rejeitar duplicatas no DTO com `@ArrayUnique(i => i.productId)`). Agregar é mais amigável ao cliente:

```ts
const items = aggregateByProduct(input.items); // soma quantities por productId
```
e usar `items` (agregado) tanto na reserva quanto em `order.items`.

---

### M2 — `order.items` usa `input.items` em vez de `reserved`
**Local:** linha 131.

**Descrição:** O pedido é persistido com `items: input.items`. Hoje `reserved` é igual a `input.items` quando tudo dá certo (todos os itens são reservados em sequência), então não há bug observável. Mas semanticamente o read model deveria refletir o que foi efetivamente reservado/agregado. Acoplar `order.items` ao input cru torna o código frágil a qualquer mudança futura (ex.: se M1 for corrigido com agregação, isto precisará mudar junto, e é fácil esquecer).

**Impacto:** Manutenibilidade / risco de divergência futura entre estoque reservado e itens do pedido.

**Correção sugerida:** Persistir a lista canônica (agregada/reservada): `items: reserved` (após M1, a lista agregada).

---

### M3 — `correlationId` propagado só no job, não no pedido persistido
**Local:** linhas 128–140 vs 143–145.

**Descrição:** O `correlationId` da requisição entra no job da fila (linha 144) mas não é gravado no `Order`. Se a fila falhar e a reconciliação re-enfileirar (cenário previsto pelo comentário da linha 142), o novo job não tem como recuperar o `correlationId` original — a rastreabilidade ponta-a-ponta quebra exatamente no caminho de recuperação. `setOrderId(orderId)` (linha 85) ajuda na correlação por pedido, mas o `correlationId` da request inicial se perde.

**Impacto:** Observabilidade degradada no caminho de reconciliação/falha — justamente onde rastrear é mais necessário.

**Correção sugerida:** Persistir `correlationId` (ou os baggage relevantes) no `Order`, para a reconciliação reconstruir o job com o mesmo contexto de trace.

---

## LOW

### L1 — `await` em loop sequencial (N+1 de lookups de produto)
**Local:** linhas 103–118.

**Descrição:** Cada item faz `await products.findById` e depois `await stock.reserve` em série. A reserva sequencial é intencional (necessária para compensação ordenada e atomicidade por produto), mas os `findById` de produto poderiam ser resolvidos em lote/paralelo antes do loop de reserva, reduzindo latência para pedidos com muitos itens (até 50).

**Impacto:** Latência da requisição cresce linearmente com o número de itens. Para 50 itens são até 100 idas-e-voltas sequenciais.

**Correção sugerida:** Pré-buscar todos os produtos (`Promise.all` dos `findById`, idealmente um `findManyById`/cache) e validar antes de iniciar as reservas; manter as reservas sequenciais.

### L2 — Cast de tipo inseguro em `(err as { code?: string })`
**Local:** linhas 66, e padrão repetido implicitamente.

**Descrição:** `const code = (err as { code?: string }).code;` assume forma do erro sem narrowing. Se `err` não for objeto (ex.: string lançada), o acesso ainda funciona mas a classificação de métrica vira `'invalid'` por padrão silenciosamente. Aceitável, mas um type guard explícito seria mais robusto.

**Impacto:** Baixo; classificação de métrica pode silenciar erros inesperados como `'invalid'`.

**Correção sugerida:** Usar um helper `function getErrorCode(e: unknown): string | undefined` com checagem `typeof e === 'object' && e !== null && 'code' in e`.

### L3 — Classificação de métrica binária demais
**Local:** linhas 66–69.

**Descrição:** O outcome de erro só distingue `INSUFFICIENT_STOCK` → `'conflict'` vs todo o resto → `'invalid'`. `DuplicateRequestError` (`code = 'DUPLICATE_REQUEST'`, um 409) e `ProductNotFoundError` (um 404/400) e falhas reais de infra (5xx) caem todos em `'invalid'`. Isso mistura erros de cliente com erros de servidor na mesma série de métrica, dificultando alarmes.

**Impacto:** Observabilidade: impossível separar 4xx esperado de 5xx de infra pela métrica.

**Correção sugerida:** Mapear por código conhecido: `INSUFFICIENT_STOCK`→`conflict`, `DUPLICATE_REQUEST`→`duplicate`, `PRODUCT_NOT_FOUND`→`invalid`, e um bucket `error`/`internal` para o resto.

### L4 — `new Date().toISOString()` e dois `randomUUID` sem injeção (testabilidade)
**Local:** linhas 77, 84, 128.

**Descrição:** Relógio (`new Date()`) e geração de UUID são acessados diretamente, não injetados. Não é bug, mas dificulta testes determinísticos de timestamps/IDs e foge um pouco do estilo hexagonal puro (efeitos colaterais não isolados atrás de porta/clock).

**Impacto:** Testabilidade; coerência arquitetural.

**Correção sugerida:** Opcional — injetar um `Clock`/`IdGenerator` como porta. Para o escopo do desafio é aceitável manter como está.

---

## Pontos positivos

- **Ordem correta anti-ghost-order**: idempotência → reserva atômica → save PENDING → enqueue. O comentário D7 documenta a decisão e o código a respeita.
- **Hexagonal limpo**: depende exclusivamente de portas via `@Inject(SYMBOL)`; nenhum vazamento de infra (Redis/BullMQ) para dentro do use case.
- **Reserva atômica** delegada à porta (`reserve` decrementa só se houver saldo), prevenindo oversell — coberto por teste de concorrência (5 checkouts / estoque 2 → 2 ok, 3 sem estoque).
- **Métricas e tracing** bem posicionados (`checkoutDuration` com `finally` garantindo `endTimer()`, spans em `stock.reserve` e `queue.enqueue`, `oversellPrevented`).
- **Compensação presente** no caminho de falha de reserva (a robustez dela é o ponto H2, mas a intenção está certa).
- **Idempotência testada** (mesma key → 1 pedido, 1 reserva) e fluxo de falha do ERP testado (FAILED + estoque compensado).
- **`finally` com `endTimer()`** garante que a métrica de duração é sempre encerrada, inclusive em erro.

---

## Veredito

**Aprovado com ressalvas.**

O fluxo principal está correto e bem coberto por testes. As ressalvas H1 (chave fantasma travando o cliente em 409 até o TTL) e H2 (compensação que mascara o erro e deixa estoque preso) devem ser endereçadas antes de produção, pois afetam disponibilidade e integridade de estoque em cenários de falha — justamente os cenários que a arquitetura assíncrona promete tratar bem. Os itens MEDIUM/LOW são melhorias incrementais de robustez, observabilidade e manutenibilidade.
