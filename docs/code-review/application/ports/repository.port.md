# Code Review — src/application/ports/repository.port.ts

## Resumo

Arquivo de contrato (ports) limpo, bem documentado e fiel à arquitetura hexagonal: só depende de tipos de domínio (`Order`, `Product`), sem nenhum vazamento de infra. Os achados não são bugs no arquivo em si, mas **lacunas de contrato** que empurram correção/concorrência para fora da porta — relevantes num cenário de checkout com idempotência e múltiplos workers. Nenhum problema CRITICAL.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 1 |
| MEDIUM     | 3 |
| LOW        | 3 |

---

## HIGH

### H1 — `OrderRepositoryPort` não oferece escrita condicional / compare-and-swap (linhas 17-22)

**Local:** linha 18 (`save(order: Order): Promise<void>`).

**Descrição:** A porta só expõe `save` como upsert incondicional ("last write wins"). Os consumidores (`checkout.worker.ts` linhas 52-87 e 104-113; `reconcile.usecase.ts` linhas 36-50) executam um padrão **read-modify-write**: `findById` → `transition(...)` → `save`. Entre o read e o write não existe nenhum mecanismo de atomicidade no contrato (nem versão, nem CAS, nem update condicional por status esperado).

**Impacto:** Em produção com BullMQ (concorrência > 1, entrega duplicada) ou com a reconciliação rodando em paralelo ao worker, duas execuções podem ler o mesmo `Order` em `PENDING`, ambas transicionarem e ambas salvarem — a segunda escrita sobrescreve a primeira (lost update). A guarda em `checkout.worker.ts:64` (`status === PROCESSING && attempt === order.attempts`) mitiga *parte* do double-invoice, mas é uma checagem em memória sobre um snapshot já potencialmente obsoleto; não há serialização garantida pela porta. O próprio domínio já reconhece a criticidade disso (comentário em `order.ts:41-42` sobre double-processing). Para um e-commerce de estoque/faturamento, lost update = pedido faturado duas vezes ou estoque compensado indevidamente.

**Correção sugerida:** Tornar a intenção de concorrência explícita no contrato. Duas opções idiomáticas:

```ts
export interface OrderRepositoryPort {
  /**
   * Persiste o pedido. Implementações DEVEM ser atômicas por id.
   * Use saveIfStatus para transições sob concorrência.
   */
  save(order: Order): Promise<void>;

  /**
   * Compare-and-swap por status: grava `order` apenas se o registro
   * atual estiver em `expectedStatus`. Retorna false se a pré-condição
   * falhar (outro worker já transicionou). Base para idempotência real.
   */
  saveIfStatus(order: Order, expectedStatus: OrderStatus): Promise<boolean>;

  findById(id: string): Promise<Order | undefined>;
  findPendingOlderThan(before: Date): Promise<Order[]>;
}
```

(ou, alternativamente, optimistic locking via um campo `version` no `Order` e `save` que rejeita versões obsoletas). Ainda que a impl atual seja in-memory single-thread, a porta é o local certo para fixar a garantia que a impl Redis/SQL precisará honrar.

---

## MEDIUM

### M1 — Contrato não documenta semântica de cópia/imutabilidade (linhas 18-19, 12-13)

**Local:** `save`/`findById` em ambas as portas.

**Descrição:** A impl in-memory faz `structuredClone`/spread defensivo em todo retorno e gravação (`in-memory-order.repo.ts:9-22`, `in-memory-product.repo.ts:35,41`) para evitar mutação acidental do estado armazenado. Isso é um **contrato implícito não escrito**: nada na interface obriga uma futura impl a clonar, nem informa ao consumidor que o objeto retornado é seguro para mutar.

**Impacto:** Uma impl que retorne a referência interna (ex.: cache em memória sem clone) introduz aliasing silencioso e corrupção de estado — bug difícil de rastrear e que não quebra nenhum teste de unidade da porta. É exatamente o tipo de divergência entre adapters que a porta deveria normatizar.

**Correção sugerida:** Documentar a garantia no JSDoc da interface (ex.: "implementações DEVEM retornar/armazenar cópias defensivas; o chamador pode mutar livremente o objeto retornado"). Opcionalmente reforçar com `Readonly<Order>` no retorno onde a mutação não for esperada.

### M2 — `findPendingOlderThan` sem paginação/limite (linha 21)

**Local:** `findPendingOlderThan(before: Date): Promise<Order[]>`.

**Descrição:** O contrato devolve um array não-limitado de todos os pedidos PENDING órfãos. O consumidor `reconcile.usecase.ts:40-63` itera todos em sequência, fazendo I/O por item (`queue.enqueue`, `orders.save`, `stock.release`).

**Impacto:** Sob backlog (ex.: fila/ERP fora do ar por um período), a reconciliação pode trazer milhares de pedidos de uma vez, carregando tudo em memória e fazendo um loop com awaits sequenciais — risco de pico de memória e de uma execução de reconciliação muito longa que segura recursos. Numa impl Redis/SQL isso vira um SCAN/SELECT sem `LIMIT`.

**Correção sugerida:** Adicionar parâmetro de limite (e idealmente cursor) ao contrato:

```ts
findPendingOlderThan(before: Date, limit?: number): Promise<Order[]>;
```

e processar em lotes no use-case.

### M3 — Sem operação de unicidade por `idempotencyKey` na porta (linhas 17-22)

**Local:** `OrderRepositoryPort` como um todo; `Order.idempotencyKey` (`order.ts:30`).

**Descrição:** O domínio modela `idempotencyKey` como atributo central do pedido, mas a porta de persistência não expõe nenhuma forma de buscar/gravar por essa chave (ex.: `findByIdempotencyKey` ou um `save` que falhe em duplicidade). A idempotência fica delegada inteiramente a outra porta (`idempotency.port.ts`), desacoplada do registro persistido do pedido.

**Impacto:** Se o store de idempotência e o store de pedidos divergirem (TTL expira, falha parcial entre as duas escritas), nada na porta de pedidos garante "um pedido por idempotencyKey". Abre janela para pedido duplicado persistido. Para checkout, isso é dado financeiro duplicado.

**Correção sugerida:** Considerar expor no contrato `findByIdempotencyKey(key: string): Promise<Order | undefined>` ou documentar explicitamente que a unicidade é responsabilidade exclusiva da `IdempotencyPort` e que `OrderRepositoryPort` confia nessa garantia upstream.

---

## LOW

### L1 — Inconsistência de convenção: símbolos DI aqui, ausência de agrupamento (linhas 4-5)

**Local:** `PRODUCT_REPO_PORT` / `ORDER_REPO_PORT`.

**Descrição:** Duas portas distintas convivem no mesmo arquivo `repository.port.ts`, enquanto `stock.port.ts`, `queue.port.ts` etc. são 1 porta por arquivo. Não é erro, mas quebra a convenção "um arquivo por port" do diretório.

**Impacto:** Manutenibilidade/descoberta. Pequeno.

**Correção sugerida:** Avaliar separar em `order-repository.port.ts` e `product-repository.port.ts`, ou manter consciente que repos ficam agrupados.

### L2 — Uso de `undefined` em vez de `null`/Result para "não encontrado" (linhas 13, 19)

**Local:** `findById(): Promise<... | undefined>` em ambas as portas.

**Descrição:** Convenção válida e consistente, mas vale anotar que `undefined` força cada consumidor a lembrar de tratar o caso ausente (feito corretamente em `checkout.worker.ts:53` e `:105`). Não há erro aqui.

**Impacto:** Cosmético; risco de NPE-like se um futuro consumidor esquecer a guarda.

**Correção sugerida:** Manter, mas a consistência (`| undefined` em todos os finders) já está boa; apenas garantir lint `no-non-null-assertion` para impedir `findById(...)!`.

### L3 — JSDoc de `OrderRepositoryPort` poderia explicitar invariantes de ordenação (linhas 16-22)

**Local:** comentário linha 16 e 20-21.

**Descrição:** `findPendingOlderThan` não documenta se o array vem ordenado (ex.: por `createdAt` ascendente). O use-case não depende de ordem hoje, mas reconciliação geralmente se beneficia de processar os mais antigos primeiro.

**Impacto:** Baixo; ambiguidade de contrato.

**Correção sugerida:** Documentar a ordenação esperada (ou explicitar "ordem não garantida").

---

## Pontos positivos

- **Aderência hexagonal exemplar:** o arquivo importa apenas tipos de domínio (`Order`, `Product`); zero dependência de NestJS, Redis ou qualquer infra. É um port puro.
- **Símbolos `Symbol(...)` para tokens de DI** (linhas 4-5) — idiomático em NestJS para injeção de interfaces, evita colisão de string tokens e é usado consistentemente nos consumidores (`@Inject(ORDER_REPO_PORT)`).
- **JSDoc útil e honesto**, incluindo a nota de que o product repo é um "fake ERP" e que `findPendingOlderThan` existe para reconciliação — contexto que ajuda o leitor a entender o porquê.
- **Tipagem sólida:** nenhum `any`, nenhum cast inseguro, retornos `Promise<... | undefined>` explícitos.
- **Coesão correta:** separação entre catálogo (read, com latência simulada) e pedidos (read model persistido) reflete bem os dois lados do problema.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é um contrato de porta sólido, idiomático e arquiteturalmente correto — não há bug que justifique bloquear. A ressalva principal é **H1**: para um sistema de checkout com múltiplos workers e idempotência, a ausência de uma primitiva de escrita condicional/atômica na própria porta empurra a corretude de concorrência para checagens em memória nos consumidores, que não são suficientes sob entrega duplicada real (BullMQ/Redis). Recomenda-se evoluir o contrato (`saveIfStatus`/versionamento) antes de uma impl distribuída, e endereçar M1–M3 como hardening do contrato.
