# Code Review — src/infrastructure/repo/in-memory-product.repo.ts

## Resumo

Adapter de repositório de produtos in-memory que simula um "ERP fake" (fonte de
verdade de produto/preço) com latência artificial. É um arquivo pequeno, coeso e
bem alinhado à arquitetura hexagonal: implementa `ProductRepositoryPort`, é
puramente leitura (a mutação de estoque vive no `StockPort` separado) e devolve
cópias defensivas, protegendo o `Map` interno. Os achados são quase todos de
robustez/manutenibilidade; nenhum bug crítico de correção foi encontrado.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 2         |
| LOW        | 4         |

---

## MEDIUM

### M1 — Cópia defensiva rasa permite mutação de campos aninhados futuros
- **Local:** linhas 24, 35, 41 (`{ ...p }`)
- **Descrição:** As cópias usadas no construtor e nos getters são *shallow*. Hoje
  `Product` (`id`, `name`, `priceCents`, `stock`) só tem primitivos, então o spread
  é suficiente para isolar o `Map` interno de mutações externas. Porém o contrato
  é frágil: no dia em que `Product` ganhar um campo objeto/array (ex.: `tags: string[]`,
  `dimensions: {...}`), o spread passará a compartilhar a referência aninhada, e um
  consumidor poderá mutar o catálogo "imutável" sem que nenhum teste acuse.
- **Impacto:** Vazamento silencioso de mutabilidade no que deveria ser a fonte de
  verdade de produto/preço. Em um checkout que lê `priceCents` para calcular total
  (`checkout.usecase.ts:117`), corrupção do catálogo é um risco financeiro.
- **Correção sugerida:** Documentar explicitamente a invariante (cópia rasa é
  intencional porque `Product` é flat) e/ou centralizar a clonagem em um helper para
  evoluir junto com o tipo. Se quiser garantia forte: `structuredClone(p)` ou
  `Object.freeze` nos valores retornados.
  ```ts
  private clone(p: Product): Product {
    return { ...p }; // Product é flat; revisar se ganhar campos aninhados
  }
  ```

### M2 — `findById` não normaliza/valida a chave de entrada
- **Local:** linhas 38-42
- **Descrição:** O lookup é `this.products.get(id)` direto, case-sensitive e sem
  `trim`. IDs de seed são uppercase (`'CAPA-001'`). Se a entrada chegar com espaço,
  case diferente ou tipo inesperado (o tipo declara `string`, mas a borda HTTP pode
  passar algo coercido), o resultado é `undefined`, que no `CheckoutUseCase`
  (`checkout.usecase.ts:105`) vira `ProductNotFoundError`. Não é incorreto, mas a
  política de matching fica implícita e divergente de um ERP real (que normalmente
  normaliza).
- **Impacto:** Falsos `ProductNotFoundError` por diferença cosmética de input;
  comportamento dependente de quem chamou ter normalizado antes. Acopla a correção a
  camadas externas.
- **Correção sugerida:** Decidir e documentar a política. Se o domínio trata IDs como
  case-insensitive, normalizar na entrada do `Map` e no lookup:
  ```ts
  async findById(id: string): Promise<Product | undefined> {
    await this.simulateLatency();
    const p = this.products.get(id?.trim());
    return p ? { ...p } : undefined;
  }
  ```
  Caso a política seja "match exato", deixar isso explícito em um comentário evita
  reabertura do debate.

---

## LOW

### L1 — `simulateLatency` não é cancelável; `setTimeout` sem cleanup
- **Local:** linhas 27-31
- **Descrição:** Cada chamada cria uma `Promise` com `setTimeout` sem `unref`/clear.
  Em testes ou shutdown, timers pendentes podem manter o event loop vivo (com `latencyMs > 0`).
  No app, a fábrica usa `latencyMs = 0` em `env === 'test'` (`infrastructure.module.ts:80`),
  então o impacto real é baixo, mas o padrão não é cancelável.
- **Impacto:** Baixo. Possível atraso de teardown / handles abertos em cenários de teste
  que instanciem com latência.
- **Correção sugerida:** Para repo de demo é aceitável; se quiser higiene,
  `const t = setTimeout(r, ms); t.unref?.();` ou aceitar um `AbortSignal`.

### L2 — Latência fixa (`maxLatencyMs` constante) não modela jitter de ERP real
- **Local:** linhas 22, 27-31
- **Descrição:** A latência é determinística (40ms). O `FakeErpClient` do projeto, por
  contraste, modela latência variável e taxa de falha. Para um "ERP fake" cuja razão de
  existir é tornar o ganho de cache observável, latência constante é uma simulação pobre
  (sem variância, sem p99).
- **Impacto:** Baixo; é simulação. Apenas reduz o realismo da demonstração de cache.
- **Correção sugerida:** Opcional — aceitar `{ minLatencyMs, maxLatencyMs }` como o
  `FakeErpClient` faz, mantendo coerência entre os adapters de simulação.

### L3 — `findAll` aloca duas vezes (spread + map de clones) a cada chamada
- **Local:** linha 35 (`[...this.products.values()].map((p) => ({ ...p }))`)
- **Descrição:** Materializa o iterador em array e depois cria um novo array de clones —
  duas passagens/alocações. Para 5 produtos é irrelevante, mas é chamado no boot pelo
  `StockSeeder` (`infrastructure.module.ts:111`) e potencialmente por listagem.
- **Impacto:** Negligenciável na escala atual; nota de eficiência se o catálogo crescer.
- **Correção sugerida:** Uma passagem: `Array.from(this.products.values(), (p) => ({ ...p }))`.

### L4 — `PRODUCT_SEED` exportado e mutável compartilhado como default do construtor
- **Local:** linhas 5-11, 21-24
- **Descrição:** `PRODUCT_SEED` é um `export const` de array mutável. O construtor o usa
  como default e o copia para o `Map` (`seed.map((p) => [p.id, { ...p }])`), então a
  instância fica isolada — bom. Porém o array exportado em si pode ser mutado por
  qualquer importador (ex.: `PRODUCT_SEED.push(...)` ou `PRODUCT_SEED[0].stock = 999`),
  afetando instâncias futuras e quem mais ler o seed.
- **Impacto:** Baixo no uso atual (instância única via DI), mas é estado global mutável
  exportado — convite a acoplamento acidental em testes.
- **Correção sugerida:** Congelar o seed: `export const PRODUCT_SEED = Object.freeze([...]) as readonly Product[];`
  e tipar o parâmetro como `readonly Product[]`.

---

## Pontos positivos

- **Aderência hexagonal exemplar:** implementa `ProductRepositoryPort` sem vazar infra
  no domínio; nenhum import de Nest/Redis/HTTP. É um POJO testável, injetado via factory
  com token `Symbol` (`PRODUCT_REPO_PORT`) — DI correta e desacoplada.
- **Imutabilidade defensiva nos getters:** retorna `{ ...p }` em `findById`/`findAll` e
  copia o seed na construção, impedindo que consumidores corrompam o `Map` interno
  (fonte de verdade de preço). Acerto importante para a corretude financeira do checkout.
- **Separação correta de responsabilidades:** o repo é estritamente leitura; a mutação de
  estoque vive no `StockPort` atômico — não há aqui o anti-padrão de decremento de
  estoque não-atômico in-place.
- **Construtor flexível e testável:** seed e latência parametrizáveis, com defaults
  sensatos; a fábrica zera latência em testes.
- **Sem concorrência problemática:** `Map.get` e spreads são síncronos; o único `await`
  é a latência simulada, sem read-modify-write, portanto sem race no próprio adapter.

## Veredito

**Aprovado com ressalvas.** O arquivo está correto e bem desenhado para seu papel
(catálogo read-only / ERP fake). Não há achados CRITICAL/HIGH. As ressalvas MEDIUM
(M1 cópia rasa frágil a evolução do tipo; M2 política de matching de ID implícita) são
endurecimentos de robustez recomendados, não bloqueadores. Os LOW são polimento opcional.
