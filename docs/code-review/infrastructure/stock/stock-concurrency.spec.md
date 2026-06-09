# Code Review — src/infrastructure/stock/stock-concurrency.spec.ts

## Resumo

O arquivo é um spec de concorrência sólido e legível que prova o requisito central do desafio (não-overselling sob N reservas concorrentes para estoque M < N) usando o `InMemoryStockAdapter`. As asserções principais são corretas e o teste mais importante (`reserve` exato == 10) é valioso. As ressalvas são de natureza de robustez/cobertura: ausência de `release` da port no teste de compensação, falta de cobertura de edge cases (quantidade <= 0, produto inexistente), e uma asserção que verifica número exato (`failed === 40`) que é correto mas levemente acoplado ao N. Nenhum achado CRITICAL ou HIGH.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 0          |
| MEDIUM     | 2          |
| LOW        | 4          |

---

## MEDIUM

### M1 — Cobertura insuficiente de edge cases do domínio (`quantity <= 0` e produto inexistente)

- **Local:** arquivo inteiro (nenhum teste cobre esses caminhos).
- **Descrição:** O domínio (`tryReserve`) trata explicitamente `quantity <= 0` retornando `{ ok: false }` (linha 14 de `domain/stock.ts`), e o adapter trata produto inexistente com `?? 0` (linhas 23/32 de `in-memory-stock.adapter.ts`). Nenhum desses comportamentos é exercitado pelo spec. Como o arquivo é nomeado/posicionado como a "prova" comportamental do estoque, esses caminhos ficam sem rede de segurança.
- **Impacto:** Uma regressão que, por exemplo, passasse a aceitar `reserve('X', 0)` como sucesso, ou que lançasse ao acessar produto inexistente em vez de retornar saldo 0, não seria detectada. Em e-commerce, aceitar reserva de quantidade 0/negativa pode corromper contadores de estoque ou idempotência.
- **Correção sugerida:** Adicionar casos de borda:

```ts
it('reserva de quantidade <= 0 falha sem alterar saldo', async () => {
  const stock = new InMemoryStockAdapter();
  await stock.init('CAPA-Q', 5);
  expect((await stock.reserve('CAPA-Q', 0)).ok).toBe(false);
  expect((await stock.reserve('CAPA-Q', -3)).ok).toBe(false);
  expect(await stock.get('CAPA-Q')).toBe(5);
});

it('produto inexistente tem saldo 0 e reserva falha', async () => {
  const stock = new InMemoryStockAdapter();
  expect(await stock.get('NAO-EXISTE')).toBe(0);
  expect((await stock.reserve('NAO-EXISTE', 1)).ok).toBe(false);
});
```

### M2 — Teste de `release` não valida o caso de compensação após falha nem o retorno da reserva original

- **Local:** linhas 37–43 (`release compensa o saldo`).
- **Descrição:** O teste reserva 1 de 1 e libera 1, esperando saldo 1. Ele não assere o `ReserveOutcome` da reserva (linha 40 descarta o retorno), nem cobre o cenário realista de compensação: reservar, depois liberar e provar que o slot voltou a ficar **reservável** (release seguido de novo reserve bem-sucedido). Também não cobre o ramo `Math.max(0, quantity)` de `release` (release com quantidade negativa não deve subtrair).
- **Impacto:** A semântica de compensação (a razão de existir do `release` em sagas/rollback de checkout) fica fracamente provada. Uma regressão onde `release` não restaura a disponibilidade real (ex.: incrementa um contador mas a reserva subsequente ainda falha) passaria.
- **Correção sugerida:** Fortalecer e estender o teste:

```ts
it('release restaura disponibilidade para nova reserva', async () => {
  const stock = new InMemoryStockAdapter();
  await stock.init('CAPA-Z', 1);
  expect((await stock.reserve('CAPA-Z', 1)).ok).toBe(true);
  expect((await stock.reserve('CAPA-Z', 1)).ok).toBe(false); // esgotado
  await stock.release('CAPA-Z', 1);
  expect(await stock.get('CAPA-Z')).toBe(1);
  expect((await stock.reserve('CAPA-Z', 1)).ok).toBe(true); // reservável de novo
});

it('release ignora quantidade negativa (não subtrai saldo)', async () => {
  const stock = new InMemoryStockAdapter();
  await stock.init('CAPA-N', 2);
  await stock.release('CAPA-N', -5);
  expect(await stock.get('CAPA-N')).toBe(2);
});
```

---

## LOW

### L1 — Asserção `expect(failed).toBe(40)` é redundante e acopla o teste ao N

- **Local:** linha 19.
- **Descrição:** Dado `N = 50` e `success === 10`, `failed` é necessariamente `40`; a asserção não adiciona poder de detecção além de `success === 10` somado a `results.length === N`. Se alguém mudar `N` (ex.: para 100) sem ajustar a constante 40, o teste quebra por motivo cosmético, não por bug real.
- **Impacto:** Fragilidade leve a refactor; manutenção desnecessária.
- **Correção sugerida:** Derivar de `N` para que a intenção fique explícita e resistente a mudança de constante:

```ts
expect(success).toBe(10);
expect(failed).toBe(N - 10);
expect(results.length).toBe(N);
```

### L2 — O teste de concorrência não prova ausência de race de forma robusta (rodada única)

- **Local:** linhas 8–21.
- **Descrição:** A "prova" de não-overselling depende do modelo single-thread do Node, que de fato garante atomicidade no `InMemoryStockAdapter` (não há `await` entre leitura e escrita). Porém, por ser uma única rodada determinística, o teste documenta mais do que estressa: ele não detectaria um adapter que introduzisse um `await` no meio da seção crítica de forma intermitente. Para o adapter in-memory atual está correto; a observação é sobre o valor como rede de regressão.
- **Impacto:** Baixo — para o adapter atual o resultado é determinístico. Vira relevante se a mesma suíte for reaproveitada para um adapter assíncrono (Redis) onde a janela de race existe.
- **Correção sugerida:** Opcionalmente repetir a rodada algumas vezes para reduzir falso-negativo em adapters futuros, e/ou variar M para garantir que o número de sucessos acompanha o estoque:

```ts
it.each([[10, 50], [1, 20], [7, 7]])(
  'sucessos == estoque (M=%i, N=%i)',
  async (M, N) => {
    const stock = new InMemoryStockAdapter();
    await stock.init('CAPA-X', M);
    const results = await Promise.all(
      Array.from({ length: N }, () => stock.reserve('CAPA-X', 1)),
    );
    expect(results.filter((r) => r.ok).length).toBe(Math.min(M, N));
    expect(await stock.get('CAPA-X')).toBe(Math.max(0, M - N));
  },
);
```

### L3 — `ReserveOutcome.remaining` nunca é verificado

- **Local:** linhas 15–20, 27–33.
- **Descrição:** A interface `ReserveOutcome` expõe `remaining`, mas nenhum teste assere esse campo. No caminho de falha do adapter, `remaining` recebe o `result.remaining` do domínio (o saldo atual inalterado), e no sucesso recebe o saldo decrementado. Esse contrato não está coberto.
- **Impacto:** Baixo — uma regressão que retornasse `remaining` incorreto (ex.: sempre 0 na falha) não seria detectada, embora o saldo final via `get` continue sendo validado indiretamente.
- **Correção sugerida:** Assere `remaining` em pelo menos um sucesso e uma falha:

```ts
const a = await stock.reserve('CAPA-Y', 3);
expect(a).toEqual({ ok: true, remaining: 2 });
const b = await stock.reserve('CAPA-Y', 3);
expect(b).toEqual({ ok: false, remaining: 2 }); // saldo intacto
```

### L4 — Duplicação de setup (boilerplate `new InMemoryStockAdapter()` / `init`) sem `beforeEach`

- **Local:** linhas 9–10, 24–25, 38–39.
- **Descrição:** Cada teste recria o adapter e inicializa manualmente. Não é um defeito (o isolamento por instância nova é até preferível para evitar estado compartilhado), mas há repetição que poderia ser fatorada com uma factory helper, mantendo o isolamento.
- **Impacto:** Cosmético; manutenibilidade marginal.
- **Correção sugerida:** Opcional — extrair `const makeStock = async (id, qty) => { const s = new InMemoryStockAdapter(); await s.init(id, qty); return s; };`. Manter instância nova por teste (não usar um adapter compartilhado em `beforeEach` com a mesma chave, para preservar isolamento).

---

## Pontos positivos

- **Cobre o requisito central corretamente:** a asserção `success === 10` sob 50 reservas concorrentes prova o não-overselling, que é o coração do desafio. Forte e bem escolhida.
- **Asserção de invariante de saldo:** verificar `get(...) === 0` após o esgotamento (linhas 20, 34) confirma que o estado final é consistente com os sucessos, não apenas a contagem de outcomes.
- **Teste multi-unidade bem desenhado** (linhas 23–35): exercita aceitar (3), rejeitar por saldo insuficiente (3 de 2 restantes) e aceitar o que cabe (2), provando a regra de saldo parcial — um cenário de off-by-one clássico bem coberto.
- **Isolamento limpo:** cada teste usa instância própria e `productId` distinto (`CAPA-X/Y/Z`), evitando vazamento de estado entre casos.
- **Sem mocks excessivos:** testa o adapter real contra o domínio real (teste de integração de unidade), o que dá confiança comportamental genuína em vez de tautologias com mocks.
- **Comentários explicam a intenção** (o porquê do not-overselling e do "only 2 remaining -> fails"), facilitando a manutenção.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo prova corretamente o requisito mais importante (não-overselling sob concorrência) e está bem isolado e legível. As ressalvas são de cobertura/robustez — todas MEDIUM/LOW, nenhuma bloqueante: vale adicionar edge cases de `quantity <= 0` e produto inexistente (M1), fortalecer a semântica de compensação do `release` (M2), e desacoplar a asserção `failed` do N (L1). Nenhum bug de correção foi encontrado no spec; as melhorias visam transformá-lo de "prova de um cenário" em "rede de regressão" mais completa.
