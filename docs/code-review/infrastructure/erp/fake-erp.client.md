# Code Review — src/infrastructure/erp/fake-erp.client.ts

**Resumo:** Adapter de teste/simulação que implementa `ErpPort`, reproduzindo latência alta e falhas intermitentes (offender #3). O código é pequeno, limpo, sem mutações de domínio nem vazamento de infra para o domínio, e preserva o `orderId` no erro. Os achados são predominantemente de robustez de configuração e qualidade do identificador gerado — nada bloqueante para um fake, mas alguns pontos importam se este adapter servir de molde para um cliente HTTP real.

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 2         |
| LOW        | 4         |

---

## MEDIUM

### M1 — Ausência de validação dos parâmetros de configuração
- **Local:** Construtor (linhas 31–35) e uso (linhas 38–42).
- **Descrição:** `FakeErpOptions` (`failRate`, `minLatencyMs`, `maxLatencyMs`) não é validado. Valores inválidos passam silenciosamente:
  - `failRate` `NaN` → `randomFail() < NaN` é sempre `false` (nunca falha), mascarando configuração quebrada.
  - `failRate` fora de `[0,1]`: `failRate > 1` faz falhar quase sempre (depende do RNG retornar exatamente 1); `failRate < 0` nunca falha.
  - `minLatencyMs` negativo: `latency` pode ficar negativo, e `setTimeout` trata negativo como 0 — comportamento por acaso correto, mas não intencional.
  - `maxLatencyMs < minLatencyMs`: tratado em parte por `Math.max(0, span)` (vira latência fixa = `min`), porém sem aviso de que a faixa está invertida.
- **Impacto:** Falha de configuração silenciosa. Em um e-commerce com chaos/latency injection, um `failRate` mal lido (ex.: env como string `"0.3"` virando `NaN` após parse incorreto a montante) desativa a simulação de falha sem nenhum sinal, dando falsa confiança ao teste de resiliência.
- **Correção sugerida:** Validar no construtor e falhar rápido (ou logar e clampar):
```ts
constructor(private readonly opts: FakeErpOptions) {
  if (!Number.isFinite(opts.failRate) || opts.failRate < 0 || opts.failRate > 1) {
    throw new Error(`failRate inválido: ${opts.failRate} (esperado 0..1)`);
  }
  if (!Number.isFinite(opts.minLatencyMs) || opts.minLatencyMs < 0) {
    throw new Error(`minLatencyMs inválido: ${opts.minLatencyMs}`);
  }
  if (!Number.isFinite(opts.maxLatencyMs) || opts.maxLatencyMs < opts.minLatencyMs) {
    throw new Error(`maxLatencyMs (${opts.maxLatencyMs}) deve ser >= minLatencyMs (${opts.minLatencyMs})`);
  }
  const shared = opts.random ?? Math.random;
  this.randomLatency = opts.randomLatency ?? shared;
  this.randomFail = opts.randomFail ?? shared;
}
```

### M2 — `erpInvoiceId` truncado para 8 hex chars: entropia baixa e risco de colisão
- **Local:** Linha 45 — `` `ERP-${randomUUID().slice(0, 8)}` ``.
- **Descrição:** Truncar o UUID v4 para os 8 primeiros caracteres hex reduz o identificador a ~32 bits. Pelo paradoxo do aniversário, colisões tornam-se prováveis na casa de ~77 mil faturas (~50% em ~2^16). Se algum consumidor a jusante tratar `erpInvoiceId` como chave única (dedup, idempotência, reconciliação), uma colisão produz comportamento incorreto difícil de diagnosticar.
- **Impacto:** Para um fake de demo o volume raramente chega lá, mas o padrão é frágil e tende a ser copiado para o adapter real. Em reconciliação ERP, IDs colidentes corrompem o mapeamento pedido→fatura.
- **Correção sugerida:** Usar o UUID completo (ou um prefixo + UUID inteiro):
```ts
return { erpInvoiceId: `ERP-${randomUUID()}` };
```
Se um formato curto for requisito, documentar explicitamente que não é garantidamente único e por quê.

---

## LOW

### L1 — Latência usa `randomLatency()` mas o `span` pode tornar o resultado pouco intuitivo no limite
- **Local:** Linha 39 — `min + Math.floor(this.randomLatency() * Math.max(0, span))`.
- **Descrição:** `span = max - min`. Com `randomLatency()` retornando valores em `[0,1)` (Math.random), o resultado fica em `[min, max)` — `max` exclusivo. Um RNG injetado que retorne exatamente `1.0` produziria `min + span = max` (inclusivo). O comportamento é correto, mas a inclusividade/exclusividade do limite superior não está documentada e depende do contrato implícito do RNG.
- **Impacto:** Baixo; apenas clareza e previsibilidade de testes determinísticos no limite superior.
- **Correção sugerida:** Comentar que o intervalo é `[min, max)` para `random ∈ [0,1)`, e considerar `span + 1` no `Math.floor` se quiser `max` inclusivo.

### L2 — `failRate === 1` não garante falha sob RNG injetado
- **Local:** Linha 42 — `this.randomFail() < this.opts.failRate`.
- **Descrição:** Com `Math.random` (nunca retorna 1.0) `failRate = 1` falha sempre, ok. Mas com um RNG de teste que possa retornar `1.0`, `1.0 < 1` é `false` e a chamada passa. O spec (`checkout-flow.spec.ts:47`) já contorna isso retornando `0` quando quer falha garantida, o que evidencia a sutileza.
- **Impacto:** Baixo; pode gerar testes intermitentes se alguém assumir que `failRate: 1` força falha com qualquer RNG.
- **Correção sugerida:** Documentar a semântica `random < failRate` ou, se "sempre falha" for desejável, tratar `failRate >= 1` como caso especial que sempre lança.

### L3 — `Promise`/`setTimeout` da latência não é cancelável (sem `AbortSignal`)
- **Local:** Linha 40 — `await new Promise((r) => setTimeout(r, latency))`.
- **Descrição:** A `ErpPort.invoice` não recebe `AbortSignal` e o sleep não é cancelável. O worker que orquestra retry/backoff não consegue interromper uma chamada em curso. Isso é uma limitação de contrato da port (já apontada na review da `erp.port.ts`), mas o adapter a herda.
- **Impacto:** Baixo no fake (latências curtas, 50–300ms). Em um cliente HTTP real, a falta de timeout/cancelamento poderia segurar o worker e inflar `queueDepth`.
- **Correção sugerida:** Quando a port evoluir para aceitar `AbortSignal`, encadear o `setTimeout` com `clearTimeout` no `abort`. Sem alteração de port, manter como está e registrar a limitação.

### L4 — Acoplamento a `Math.random`/`setTimeout` globais dentro do método
- **Local:** Linha 39 (`Math.floor`, indiretamente `Math.max`) e linha 40 (`setTimeout`).
- **Descrição:** O RNG já é injetável (bom), mas o relógio/`setTimeout` não. Testes que queiram validar a latência sem realmente esperar precisam de fake timers do Jest. Não é um defeito, apenas reduz a testabilidade pura.
- **Impacto:** Muito baixo; o spec contorna usando `min/max = 0`.
- **Correção sugerida:** Opcional — injetar um `sleep: (ms) => Promise<void>` nas options para testes, caso se queira asserção determinística sobre latência.

---

## Pontos positivos
- **Aderência hexagonal correta:** implementa `ErpPort`, depende apenas de tipos de domínio (`Order`) e da port; nenhum vazamento de infra para o domínio.
- **Determinismo testável:** RNG injetável com draws separados para latência e falha (`randomLatency`/`randomFail`), evitando correlação espúria — design cuidadoso.
- **Tratamento de erro limpo:** `ErpInvoiceError` tipado, com `name` setado e `orderId` preservado na mensagem; sem `catch` vazio nem perda de stack.
- **Guarda de `span` negativo:** `Math.max(0, span)` evita latência negativa por `span` invertido.
- **Sem estado mutável compartilhado:** método `invoice` é stateless além das opções imutáveis (`readonly`), seguro sob concorrência; provider é instanciado via factory com escopo singleton adequado.
- **Sem segredos nem injeção:** não há entrada externa interpolada de forma perigosa; `randomUUID` de `node:crypto`.

---

## Veredito

**Aprovado com ressalvas.**

O arquivo é sólido e adequado ao papel de fake/simulador. Recomenda-se, antes de usá-lo como referência para um adapter ERP real: (M1) adicionar validação de configuração para evitar desativação silenciosa da simulação de falha e (M2) usar o UUID completo no `erpInvoiceId` para eliminar o risco de colisão. Os achados LOW são melhorias de clareza/testabilidade e não bloqueiam.
