# Code Review — src/infrastructure/cache/cache.spec.ts

## Resumo

Suíte de testes do `InMemoryCacheAdapter` cobrindo cache-aside, single-flight (anti-stampede), expiração por TTL e fallback stale-while-error. Os quatro testes existentes são corretos e legíveis, mas a suíte depende de timers reais (frágil/lenta), não fixa as flags `hit`/`stale` em pontos críticos e deixa caminhos importantes sem cobertura (rethrow sem fallback, `del`, propagação de erro no single-flight). Nenhum bug funcional no teste em si, mas a cobertura comportamental é parcial.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0 |
| HIGH       | 2 |
| MEDIUM     | 4 |
| LOW        | 3 |

---

## HIGH

### H1 — Dependência de timers reais com margens apertadas (flakiness em CI)
- **Local:** linhas 25, 41–42, 48 (e indiretamente 20–35).
- **Descrição:** Toda a noção de tempo da suíte usa `setTimeout` real. Os TTLs e esperas têm margens muito estreitas: TTL 10ms vs `sleep(20)` (linha 39–42) e TTL 5ms vs `sleep(10)` (linha 47–48). Em runner carregado (CI compartilhado, GC pause, Windows timer resolution ~15ms), o `setTimeout(20)` pode disparar antes de o relógio efetivo ultrapassar `expiresAt`, ou a expiração de 5ms pode não ocorrer de forma determinística no momento esperado.
- **Impacto:** Testes intermitentes (flaky). A pior consequência de um teste flaky é a erosão de confiança — falhas reais passam a ser ignoradas como "ruído". Além disso a suíte fica lenta sem necessidade (somatório de sleeps reais).
- **Correção sugerida:** Usar fake timers do Jest e controlar o relógio deterministicamente. O adapter usa `Date.now()`, totalmente mockável.
  ```ts
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('expira após o TTL', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 1, 10);
    expect(await cache.get('k')).toBe(1);
    jest.advanceTimersByTime(11); // ultrapassa expiresAt deterministicamente
    expect(await cache.get('k')).toBeUndefined();
  });
  ```
  Para o single-flight (linha 25), `jest.advanceTimersByTimeAsync(20)` permite avançar o `setTimeout` interno do loader sem espera real. Onde fake timers forem inviáveis, no mínimo aumentar a folga (TTL 10ms / espera 50ms) para reduzir flakiness.

### H2 — Caminho de erro sem fallback (`staleOnError` ausente/false) não é testado
- **Local:** ausência — referente a `in-memory-cache.adapter.ts` linhas 70–76.
- **Descrição:** O único teste de falha do loader (linhas 45–61) exercita apenas `staleOnError: true` com `lastKnown` presente. Os ramos críticos de propagação de erro nunca são cobertos:
  1. loader lança e `staleOnError` é `false`/omitido → deve **re-lançar** (linha 75 do adapter);
  2. loader lança, `staleOnError: true` mas **não há `lastKnown`** → deve re-lançar (a condição `this.lastKnown.has(key)` é `false`).
- **Impacto:** Esses ramos definem o comportamento de falha do checkout sob indisponibilidade do ERP/fonte. Uma regressão que engula o erro silenciosamente (anti-pattern grave em e-commerce — serviria `undefined`/valor inválido em vez de falhar alto) passaria despercebida. Este é exatamente o tipo de regressão que testes existem para barrar.
- **Correção sugerida:** Adicionar dois testes:
  ```ts
  it('re-lança o erro quando staleOnError não está habilitado', async () => {
    const cache = new InMemoryCacheAdapter();
    await expect(
      cache.getOrLoad('k', 1000, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
  });

  it('re-lança quando staleOnError=true mas não há lastKnown', async () => {
    const cache = new InMemoryCacheAdapter();
    await expect(
      cache.getOrLoad('novo', 1000, async () => { throw new Error('boom'); }, { staleOnError: true }),
    ).rejects.toThrow('boom');
  });
  ```

---

## MEDIUM

### M1 — Teste de single-flight não fixa as flags `hit`/`stale` nem a contagem de misses
- **Local:** linhas 20–35.
- **Descrição:** O teste valida `loads === 1` e que todos os `value` são iguais, mas ignora `hit`/`stale`. No adapter, as chamadas coalescidas retornam `hit: true` (linha 53) e o primeiro caller retorna `hit: false` (linha 69). A semântica de `hit` para um caller que **sofreu miss e foi coalescido** é discutível (foi um miss compartilhado, não um hit de cache) — e o teste não ancora nenhuma das interpretações. Qualquer mudança nessa flag (intencional ou regressão) não seria detectada.
- **Impacto:** A flag `hit` alimenta métricas/observabilidade (taxa de hit do cache). Se consumidores contabilizam hit/miss para Prometheus, uma semântica errada distorce o painel sem quebrar teste. Asserção frágil por omissão.
- **Correção sugerida:** Decidir e fixar o contrato. Ex.: exatamente um `hit === false` no grupo concorrente:
  ```ts
  const misses = results.filter((r) => r.hit === false).length;
  expect(misses).toBe(1);
  expect(results.every((r) => r.stale === false)).toBe(true);
  ```
  Se a intenção for que coalescidos contem como miss, ajustar o adapter e o teste juntos. O importante é que o teste documente a decisão.

### M2 — Propagação de erro sob single-flight não é testada
- **Local:** ausência — referente ao adapter linhas 56–76.
- **Descrição:** Não há teste para o cenário de concorrência + falha: N callers coalescidos sobre uma chave cujo loader lança. É preciso garantir que (a) cada waiter recebe o erro (ou o stale, se habilitado), (b) o `inflight` é limpo no `finally` (linha 62) permitindo retry posterior, e (c) o loader roda uma única vez mesmo falhando.
- **Impacto:** É justamente o caminho de race condition mais sensível (estampede sob falha do ERP). Um vazamento no `inflight` Map prenderia a chave para sempre (todos os retries futuros aguardando uma promise já rejeitada) — falha difícil de diagnosticar em produção e invisível aos testes atuais.
  > Observação: o waiter coalescido (linha 52) faz `await existing` mas **não** aplica `staleOnError`; ele propaga a rejeição diretamente. Um teste explicitaria essa assimetria entre o primeiro caller (que tem fallback stale) e os coalescidos (que não têm).
- **Correção sugerida:**
  ```ts
  it('single-flight: erro do loader é propagado a todos e a chave é liberada para retry', async () => {
    const cache = new InMemoryCacheAdapter();
    let calls = 0;
    const loader = async () => { calls++; await new Promise(r => setTimeout(r, 10)); throw new Error('erp down'); };
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => cache.getOrLoad('hot', 1000, loader)),
    );
    expect(calls).toBe(1);
    expect(settled.every(s => s.status === 'rejected')).toBe(true);
    // chave liberada: nova chamada executa o loader de novo
    await expect(cache.getOrLoad('hot', 1000, async () => 'ok')).resolves.toMatchObject({ value: 'ok' });
  });
  ```

### M3 — Método `del()` sem cobertura
- **Local:** ausência — adapter linhas 34–36.
- **Descrição:** `del` faz parte do `CachePort` e remove a entrada de `store`, mas **não** limpa `lastKnown`. Esse comportamento (intencional? para preservar stale fallback após invalidação?) não está documentado nem testado.
- **Impacto:** Invalidação de cache é operação sensível (ex.: invalidar preço/estoque após escrita). Sem teste, uma regressão em `del` passa em silêncio. Além disso, o fato de `del` não tocar `lastKnown` significa que após `del` + miss + erro do loader, o `staleOnError` ainda serviria um valor "deletado" — comportamento surpreendente que merece um teste explícito que o congele ou corrija.
- **Correção sugerida:** Adicionar teste cobrindo `del` removendo o hit, e um teste que documente a interação `del` × `lastKnown`/`staleOnError`.

### M4 — Não há verificação de repopulação após stale e após expiração
- **Local:** linhas 37–43 e 45–61.
- **Descrição:** Após o fallback stale (linha 59–60), o teste não verifica o que acontece na próxima chamada bem-sucedida (o valor novo é cacheado? `hit` volta a `true`?). No teste de expiração, não se verifica que um `getOrLoad` subsequente re-executa o loader e re-popula.
- **Impacto:** O ciclo completo cache-aside (miss → load → hit → expire → reload) é o comportamento central do componente; cobri-lo só por partes deixa transições sem garantia.
- **Correção sugerida:** Estender os testes existentes com uma chamada adicional verificando a transição (ex.: após stale, um loader que sucede repopula e a chamada seguinte retorna `hit: true, stale: false`).

---

## LOW

### L1 — Instanciação repetida em vez de `beforeEach`
- **Local:** linhas 5, 21, 38, 46.
- **Descrição:** `new InMemoryCacheAdapter()` é repetido em cada teste.
- **Impacto:** Ruído/manutenção; isolamento já está garantido por instância nova, mas centralizar reduz duplicação e facilita adicionar setup futuro.
- **Correção sugerida:** `let cache; beforeEach(() => { cache = new InMemoryCacheAdapter(); });`.

### L2 — Magic numbers de tempo sem nome
- **Local:** linhas 12–13 (`1000`), 25 (`20`), 39/41 (`10`/`20`), 47/48 (`5`/`10`).
- **Descrição:** Valores de TTL e sleep aparecem como literais soltos; a relação "sleep > ttl para expirar" fica implícita.
- **Impacto:** Legibilidade e fragilidade — fácil quebrar a margem ao ajustar um número sem notar a relação.
- **Correção sugerida:** Extrair constantes nomeadas (`const TTL = 10; const PAST_TTL = TTL + 5;`) ou, idealmente, eliminar via fake timers (ver H1).

### L3 — Asserção `results.every(...)` mascara qual elemento falhou
- **Local:** linha 34.
- **Descrição:** `expect(results.every((r) => r.value === 'value')).toBe(true)` colapsa 20 resultados em um booleano; em falha o relatório diz apenas `expected true, got false`, sem indicar qual índice divergiu.
- **Impacto:** Diagnóstico mais difícil quando o teste falhar.
- **Correção sugerida:** `expect(results.map(r => r.value)).toEqual(Array(20).fill('value'));` — produz diff legível apontando o elemento divergente.

---

## Pontos positivos

- Nomes de teste descritivos e em domínio (single-flight, anti-stampede, stale-while-error), comunicando intenção comportamental, não implementação.
- O teste de single-flight (linhas 20–35) é genuinamente bom: usa `Promise.all` com 20 chamadas concorrentes e um loader com atraso real para forçar a janela de corrida — valida a propriedade de coalescência de forma honesta (`loads === 1`).
- Cobre as quatro propriedades centrais do contrato `CachePort`: cache-aside, coalescência, TTL e stale fallback.
- Testa contra a implementação concreta correta (adapter in-memory), sem mocks excessivos — testes de comportamento real, não de interação.
- Cada teste é isolado (instância nova), sem estado compartilhado entre casos.

---

## Veredito

**Aprovado com ressalvas.**

Os testes presentes estão corretos e não contêm bugs. Contudo, a suíte tem lacunas relevantes de cobertura comportamental nos caminhos de falha (H2: rethrow sem fallback — crítico para o comportamento sob indisponibilidade do ERP) e de concorrência sob erro (M2), além de não fixar as flags `hit`/`stale` no single-flight (M1) e depender de timers reais com margens apertadas (H1, fonte provável de flakiness). Recomenda-se, antes de considerar o componente "bem testado": migrar para fake timers, adicionar os testes de rethrow/`del`/propagação de erro sob single-flight, e ancorar a semântica das flags.
