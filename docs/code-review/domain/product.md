# Code Review — src/domain/product.ts

**Resumo:** Arquivo de domínio puro, pequeno e bem posicionado na arquitetura hexagonal: define os tipos `Product` (modelo interno) e `ProductView` (read model público) e uma função de mapeamento pura `toProductView`. Não há vazamento de infraestrutura, dependência de NestJS, mutação ou efeito colateral. As ressalvas são de design/contrato, não de correção crítica: a principal é que `ProductView` expõe `stock` exato apesar de o comentário afirmar "não vaza detalhes internos", e a ausência de normalização de valores limite (negativos/NaN) que confiam inteiramente no adapter a montante.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## CRITICAL

Nenhum achado.

---

## HIGH

Nenhum achado.

---

## MEDIUM

### M1 — `ProductView` expõe `stock` exato, contradizendo o próprio contrato de "não vazar detalhes"

- **Local:** linhas 13, 19, 28.
- **Descrição:** O comentário da interface (linha 13) afirma explicitamente: *"Public product view exposed by the storefront (does not leak internal details)"*. Porém o campo `stock` (linha 19), preenchido com o valor cru `p.stock` (linha 28), expõe ao cliente a quantidade exata de inventário restante. O `available: p.stock > 0` (linha 27) já fornece o sinal de disponibilidade que a vitrine precisa; o número exato é informação de negócio sensível.
- **Impacto:**
  - **Contradição de contrato:** o código faz o oposto do que o comentário promete, o que confunde manutenção e revisões futuras.
  - **Exposição competitiva / inteligência de mercado:** concorrentes e scrapers podem inferir volume de vendas, velocidade de giro e níveis de reposição monitorando `stock` ao longo do tempo.
  - **Vetor de abuso:** expor estoque exato facilita ataques de oversell/hoarding direcionados e enumeração de quanto reservar para esgotar um SKU.
  - Em e-commerce real costuma-se expor no máximo faixas ("últimas unidades") em vez do número exato.
- **Correção sugerida:** Remover `stock` do read model público, ou substituí-lo por um sinal de baixa granularidade. Se algum consumidor legítimo precisar do número (ex.: painel administrativo), use um view object separado, não o `ProductView` da vitrine.

  ```ts
  /** Public product view exposed by the storefront (does not leak internal details). */
  export interface ProductView {
    id: string;
    name: string;
    priceCents: number;
    available: boolean;
    // 'stock' removido. Se precisar de sinal de escassez, prefira faixa:
    // stockLevel?: 'out' | 'low' | 'in_stock';
  }

  export function toProductView(p: Product): ProductView {
    return {
      id: p.id,
      name: p.name,
      priceCents: p.priceCents,
      available: p.stock > 0,
    };
  }
  ```

  Se a exposição de `stock` for um requisito de produto consciente, então corrija o **comentário** da linha 13 para não afirmar que nada é vazado — alinhe documentação e código.

### M2 — Ausência de normalização de valores-limite (`stock` negativo, `priceCents` negativo/NaN) propaga estado inválido para o cliente

- **Local:** linhas 22-30 (toda a função `toProductView`).
- **Descrição:** A função confia 100% na sanidade dos dados vindos do adapter/ERP e repassa `priceCents` e `stock` sem validação. Cenários plausíveis neste sistema:
  - `stock` negativo: o comentário de `stock.ts` deixa claro que a atomicidade real é responsabilidade do adapter (Redis Lua DECRBY). Sob race condition ou bug do adapter, o estoque pode ficar negativo. Nesse caso `available: p.stock > 0` corretamente retorna `false` (bom), **mas** o campo `stock: -3` é exposto cru ao cliente — um número absurdo na vitrine.
  - `priceCents` negativo, `NaN` ou não-inteiro: passa direto para `ProductView.priceCents`, podendo gerar preço negativo/`NaN` no front e, pior, em qualquer cálculo de total a jusante.
- **Impacto:** Falha silenciosa: dados corrompidos a montante viram resposta "válida" da API sem nenhum sinal. Como `priceCents` é monetário, valor inválido é especialmente perigoso. Não é CRITICAL porque o domínio depende legitimamente do ERP como fonte de verdade, mas uma fronteira de read model é o lugar natural para clamping defensivo.
- **Correção sugerida:** Aplicar normalização defensiva mínima no mapeamento (e/ou validar `Product` na borda de entrada do repositório). Exemplo de clamp barato:

  ```ts
  export function toProductView(p: Product): ProductView {
    const stock = Number.isFinite(p.stock) ? Math.max(0, Math.trunc(p.stock)) : 0;
    return {
      id: p.id,
      name: p.name,
      priceCents: Number.isFinite(p.priceCents) ? Math.max(0, Math.trunc(p.priceCents)) : 0,
      available: stock > 0,
      stock, // se M1 for adotado, este campo desaparece
    };
  }
  ```

  Alternativa mais arquitetural: validar `Product` (zod/class-validator) na saída do `ProductRepositoryPort` e falhar ruidosamente em vez de mascarar — escolha conforme a política de tolerância a falhas do ERP. O importante é que estado inválido não chegue silenciosamente ao cliente.

---

## LOW

### L1 — `toProductView` não tem guarda para `p` null/undefined

- **Local:** linhas 22-23.
- **Descrição:** Se `p` for `undefined`/`null`, o acesso `p.id` lança `TypeError`. Hoje os dois call sites (`list-products.usecase.ts:55-56` e `:44` via `value.map`) garantem que `value` não é nulo antes de chamar, então **não há bug atual**. É uma observação de robustez/contrato, não um defeito.
- **Impacto:** Baixo. A função é pura e exportada; um futuro consumidor pode chamá-la sem o guard e receber um stack trace cru em vez de um erro de domínio (`ProductNotFoundError`).
- **Correção sugerida:** Manter a responsabilidade de "não-nulo" no caller é aceitável e idiomático para função pura. Se quiser tornar o contrato explícito, documente no JSDoc que `p` deve ser não-nulo, ou tipe o caller para nunca passar `undefined` (já é o caso). Não recomendo adicionar runtime guard aqui — apenas registrar a expectativa.

### L2 — `ProductView` duplica a forma de `Product` exceto por um campo, sem reuso de tipo

- **Local:** linhas 5-20.
- **Descrição:** `ProductView` repete `id`, `name`, `priceCents`, `stock` de `Product` e adiciona `available`. A duplicação é pequena, mas se `Product` ganhar/renomear campos, é fácil os dois tipos divergirem silenciosamente.
- **Impacto:** Baixo (manutenção). Em objetos tão pequenos o custo é mínimo — alinhado com a justificativa YAGNI registrada em `DESIGN-PATTERNS.md:380`.
- **Correção sugerida:** Opcional. Poderia derivar via utilitário de tipo, ex.: `type ProductView = Omit<Product, never> & { available: boolean }` ou, se M1 remover `stock`, `Pick<Product, 'id' | 'name' | 'priceCents'> & { available: boolean }`. Só vale a pena se o read model crescer; hoje a explicitude atual é defensável.

### L3 — Comentário JSDoc do read model não acompanha o campo `stock`

- **Local:** linhas 13-20.
- **Descrição:** Consequência documental de M1: o comentário diz "does not leak internal details" enquanto `stock` é, por definição, um detalhe interno de inventário. Mesmo que se decida manter `stock` (decisão de produto), o comentário fica enganoso.
- **Impacto:** Baixo, mas custo de manutenção/auditoria — revisores futuros confiarão no comentário e podem assumir que nada sensível é exposto.
- **Correção sugerida:** Ao resolver M1, ajustar o comentário para refletir a realidade (ex.: "expõe disponibilidade; não inclui campos internos de auditoria/ERP") e documentar conscientemente a decisão sobre `stock`.

---

## Pontos positivos

- **Domínio puro e hexagonal exemplar:** zero import de infra, NestJS, Redis ou I/O. Apenas tipos e uma função pura — exatamente o que se espera da camada de domínio.
- **Separação de read model:** ter `ProductView` distinto de `Product` é a decisão correta para isolar o modelo público do interno (independente da ressalva M1 sobre `stock`).
- **Imutabilidade:** `toProductView` não muta a entrada e retorna um novo objeto literal; sem efeitos colaterais, trivialmente testável.
- **`priceCents` em inteiro:** evita corretamente os problemas de ponto flutuante em valores monetários, com a intenção documentada (linha 3).
- **`available` derivado, não armazenado:** computar disponibilidade a partir de `stock` em vez de manter um campo redundante evita inconsistência de estado.
- **Nomes claros e JSDoc presente:** a intenção de cada tipo está documentada (a ressalva é só o desalinhamento pontual de M1/L3).

---

## Veredito

**Aprovado com ressalvas.**

O arquivo está correto, puro e bem encaixado na arquitetura — sem achados CRITICAL/HIGH. As duas ressalvas MEDIUM merecem ação antes de tratar isto como "pronto para produção sensível": **(M1)** decidir conscientemente e alinhar código+comentário sobre a exposição de `stock` no read model público, e **(M2)** adicionar normalização/validação defensiva de valores-limite na fronteira do read model (ou validar `Product` na saída do repositório). Os itens LOW são melhorias opcionais de robustez e documentação.
