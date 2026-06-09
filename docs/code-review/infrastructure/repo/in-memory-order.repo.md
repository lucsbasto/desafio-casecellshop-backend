# Code Review — src/infrastructure/repo/in-memory-order.repo.ts

## Resumo

Adapter in-memory simples e, em geral, bem-feito: implementa corretamente a porta `OrderRepositoryPort` e usa `structuredClone` nas três operações para isolar o estado interno de mutações externas (boa defesa). Os problemas reais não são bugs grosseiros do arquivo, mas **limitações de contrato** que ficam visíveis quando este adapter é exercido sob concorrência (worker + reconciliação): `save` é um *put* cego sem controle de concorrência otimista nem unicidade por `idempotencyKey`, e `findPendingOlderThan` faz full-scan sem ordenação/limite e silencia `createdAt` inválido.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 2 |
| MEDIUM     | 3 |
| LOW        | 3 |

---

## HIGH

### H1 — `save` é last-write-wins sem versão/CAS: lost update entre worker e reconciliação (linha 8-11)

**Local:** `save(order)` — `this.orders.set(order.id, structuredClone(order))`.

**Descrição:** `save` sobrescreve incondicionalmente a entrada por `order.id`. Não há `version`/`updatedAt`-check nem operação de compare-and-swap. `ReconcileUseCase` (`reconcile.usecase.ts:36-50`) opera sobre um **snapshot stale** vindo de `findPendingOlderThan` e depois grava `FAILED`; em paralelo o `CheckoutWorker` (`checkout.worker.ts:77-113`) pode gravar `PROCESSING`/`CONFIRMED` para o mesmo `orderId`. O último `save` vence e apaga a transição do outro.

**Impacto:** Em Node single-thread os dois `save` não corrompem o `Map`, mas como ambos os fluxos leem (clone) → transicionam em memória → gravam, há janela de read-modify-write não atômica entre o `await` de leitura e o `await` de `save`. Resultado: pedido pode terminar `FAILED` (estoque liberado) apesar de o worker já tê-lo `CONFIRMED`, ou vice-versa — oversell/double-release. É a contraparte de persistência da race já apontada em `reconcile.usecase.md`.

**Correção sugerida:** Expor um `save` com checagem otimista (rejeitar se a versão/`updatedAt` corrente divergir do esperado) e tratar o conflito no caller. Exemplo de CAS no adapter:

```ts
async save(order: Order, expectedUpdatedAt?: string): Promise<void> {
  const current = this.orders.get(order.id);
  if (expectedUpdatedAt !== undefined && current && current.updatedAt !== expectedUpdatedAt) {
    throw new OptimisticLockError(order.id);
  }
  this.orders.set(order.id, structuredClone(order));
}
```

A assinatura ideal pertence à porta (`OrderRepositoryPort`), então a correção definitiva é coordenada com o review de `repository.port.ts`. No mínimo, documentar que o adapter atual **não** oferece isolamento.

### H2 — `createdAt` inválido é silenciosamente ignorado em `findPendingOlderThan` (linha 21)

**Local:** `new Date(o.createdAt).getTime() < cutoff`.

**Descrição:** Se `o.createdAt` não for parseável, `new Date(...).getTime()` retorna `NaN`. Qualquer comparação com `NaN` (`NaN < cutoff`) é `false`, então o pedido **nunca** é considerado candidato à reconciliação.

**Impacto:** Um pedido PENDING com `createdAt` corrompido fica órfão para sempre — nunca re-enfileirado nem marcado `FAILED`, e o estoque reservado nunca é compensado. É uma falha silenciosa: nenhum erro, nenhum log. Para checkout isso é estoque preso permanentemente. (O `reconcile.usecase.md` já nota o lado do loop infinito; aqui o sintoma complementar é o *skip* permanente.)

**Correção sugerida:** Detectar `NaN` e tratar explicitamente — logar/observar e, idealmente, tratar pedido com timestamp inválido como “muito antigo” para forçar compensação determinística:

```ts
.filter((o) => {
  if (o.status !== OrderStatus.PENDING) return false;
  const t = new Date(o.createdAt).getTime();
  if (Number.isNaN(t)) return true; // candidato: timestamp inválido não pode ficar órfão
  return t < cutoff;
})
```

(Decisão de “incluir” vs “logar e excluir” deve casar com a política do `ReconcileUseCase`.)

---

## MEDIUM

### M1 — Sem unicidade por `idempotencyKey` no store de pedidos (linhas 5-24)

**Local:** classe inteira; `Order.idempotencyKey` (`order.ts:30`).

**Descrição:** O domínio trata `idempotencyKey` como atributo central, mas este repositório indexa apenas por `id` e não oferece busca/gravação por chave de idempotência (espelhando a lacuna já registrada em `repository.port.md` M3). A unicidade fica delegada inteiramente a outra porta (`idempotency.port.ts`).

**Impacto:** Se o store de idempotência e o de pedidos divergirem (TTL expira, falha parcial entre as duas escritas), nada neste adapter impede dois `Order` distintos com a mesma `idempotencyKey`. Para checkout, é dado financeiro duplicado.

**Correção sugerida:** Manter um índice secundário `Map<idempotencyKey, orderId>` e expor `findByIdempotencyKey`, ou um `save` que rejeite duplicidade — coordenado com a evolução da porta. Pelo menos documentar que a garantia de unicidade vive fora deste adapter.

### M2 — `findPendingOlderThan` sem ordenação nem limite (linhas 18-23)

**Local:** corpo de `findPendingOlderThan`.

**Descrição:** Faz `[...this.orders.values()]` (full materialização) + `filter` + `map(structuredClone)` sobre **todo** o store, sem `limit` nem ordenação por `createdAt`. O resultado clona N pedidos inteiros a cada varredura.

**Impacto:** O `ReconcileScheduler` roda a cada 15s (`@Interval(15000)`). Com o store crescendo, cada tick percorre e clona todos os pedidos PENDING — custo O(total) e alocação proporcional, mesmo que só poucos precisem de ação. Sem ordenação, a reconciliação não processa “mais antigos primeiro”. É in-memory, mas o port preserva o caminho para um backend real onde isso vira full-table-scan sem índice.

**Correção sugerida:** Aceitar `limit?` e ordenar por `createdAt` ascendente antes de clonar; clonar só o necessário:

```ts
async findPendingOlderThan(before: Date, limit?: number): Promise<Order[]> {
  const cutoff = before.getTime();
  const out = [...this.orders.values()]
    .filter((o) => o.status === OrderStatus.PENDING && new Date(o.createdAt).getTime() < cutoff)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return (limit ? out.slice(0, limit) : out).map((o) => structuredClone(o));
}
```

### M3 — `save` não valida `order.id` (linhas 8-11)

**Local:** `this.orders.set(order.id, ...)`.

**Descrição:** Se `order.id` vier `undefined`/`''` (bug a montante), o `Map` aceita a chave silenciosamente. Um `id` vazio colide com qualquer outro `save` de `id` vazio, sobrescrevendo pedidos.

**Impacto:** Corrupção silenciosa difícil de rastrear — um pedido sem id válido “engole” outro. Como adapter de persistência, é a última linha de defesa antes do estado virar inconsistente.

**Correção sugerida:** Guard barato no início de `save`:

```ts
if (!order.id) throw new Error('InMemoryOrderRepository.save: order.id ausente');
```

---

## LOW

### L1 — `structuredClone` em `save` pode lançar para valores não-clonáveis (linha 10)

**Local:** `structuredClone(order)`.

**Descrição:** `Order` hoje é um objeto plano (strings, números, arrays de objetos planos), então `structuredClone` é seguro. Mas se o tipo evoluir e algum campo passar a carregar função, `Symbol`, ou classe não suportada, `structuredClone` lança `DataCloneError` em runtime — uma fragilidade latente acoplada ao formato do `Order`.

**Impacto:** Baixo hoje; vira bug de runtime no futuro se o `Order` ganhar campos não-serializáveis. Apenas registrar a premissa “`Order` deve permanecer um POJO serializável”.

**Correção sugerida:** Comentário documentando a invariante, ou um teste que clona um `Order` representativo para travar a premissa.

### L2 — Variável `o` pouco descritiva e duplicação de `structuredClone` (linhas 14-15, 22)

**Local:** `findById` (`const o = ...`) e `map((o) => structuredClone(o))`.

**Descrição:** Nome `o` é genérico; o padrão de clonar-na-saída se repete em três métodos sem um helper.

**Impacto:** Cosmético/manutenção. Um helper `private clone(order: Order)` centralizaria a estratégia de cópia (e o ponto único para trocar `structuredClone` por outra estratégia, ex.: L1).

**Correção sugerida:** Renomear `o` → `order` e extrair `private clone(order: Order): Order { return structuredClone(order); }`.

### L3 — Ausência de teste unitário dedicado ao adapter (arquivo de teste inexistente)

**Local:** não há `in-memory-order.repo.spec.ts` (apenas o build em `dist/`).

**Descrição:** O adapter é exercido indiretamente por `checkout-flow.spec.ts`, mas não há teste que trave o comportamento específico: isolamento por clone (mutar o retorno não afeta o store), filtro de `findPendingOlderThan` (limite de `cutoff`, status não-PENDING excluídos, `createdAt` inválido) e `findById` para id inexistente.

**Impacto:** Comportamentos sutis (clone defensivo, edge de data) podem regredir sem detecção.

**Correção sugerida:** Adicionar spec cobrindo: mutar objeto retornado por `findById`/`save` não vaza para o store; `findPendingOlderThan` exclui CONFIRMED/PROCESSING e respeita `< cutoff` (não `<=`); `findById` de id ausente retorna `undefined`.

---

## Pontos positivos

- **Clone defensivo consistente** (`structuredClone`) nas três operações — entrada e saída isoladas do estado interno; evita o clássico bug de “mutação externa altera o store”.
- **Aderência hexagonal correta:** implementa `OrderRepositoryPort` e não vaza tipo de infra para o domínio; depende só de `Order`/`OrderStatus`.
- **`findById` retorna `undefined` explicitamente** (não `null`, não lança) — coerente com o contrato da porta.
- **Comparação correta com `< cutoff`** (estritamente menor), sem off-by-one no limite de tempo.
- **Código pequeno, legível e sem `any`/asserções de tipo inseguras.**
- **`Map` como store** é a estrutura certa para lookup por id O(1).

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto para um adapter in-memory e bem isolado por clone. Nenhum achado é bloqueante *isoladamente* dentro do escopo “in-memory”, mas H1 (last-write-wins sem CAS) e H2 (`createdAt` inválido silenciado) têm consequências reais de oversell/estoque-preso quando combinados ao worker e à reconciliação, e devem ser endereçados — preferencialmente em conjunto com a evolução de `OrderRepositoryPort` (unicidade por `idempotencyKey` e `limit`/ordenação em `findPendingOlderThan`).
