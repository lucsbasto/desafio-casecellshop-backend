# Code Review — src/application/ports/erp.port.ts

## Resumo

Arquivo de porta (interface) minúsculo e idiomático para a arquitetura hexagonal: define o token de DI `ERP_PORT` (Symbol) e a interface `ErpPort` com um único método `invoice`. O arquivo está sólido, sem dependências de infraestrutura e sem bugs de correção. As observações abaixo são de severidade baixa, voltadas a robustez contratual e clareza para futuros adapters (ex.: cliente ERP real).

| Severidade | Quantidade |
|------------|-----------|
| CRITICAL   | 0         |
| HIGH       | 0         |
| MEDIUM     | 0         |
| LOW        | 4         |

---

## CRITICAL

Nenhum achado.

## HIGH

Nenhum achado.

## MEDIUM

Nenhum achado.

## LOW

### LOW-1 — Contrato de idempotência não expresso na porta
- **Local:** linha 11 (`invoice(order: Order): Promise<{ erpInvoiceId: string }>`)
- **Descrição:** O worker (`checkout.worker.ts`) chama `invoice` dentro de um fluxo com retry/backoff e proteção contra processamento duplicado. Numa integração ERP real, um retry após timeout pode reenviar uma fatura já criada, causando faturamento duplicado. A porta não documenta nem oferece mecanismo (ex.: chave de idempotência) para que o adapter deduplique a chamada. O `FakeErpClient` atual mascara isso por nunca persistir nada, mas o contrato da porta é o lugar correto para fixar essa expectativa.
- **Impacto:** Risco de fatura duplicada em produção quando a porta for implementada por um ERP real; ambiguidade sobre quem é responsável pela deduplicação (worker vs. adapter). Em e-commerce, faturamento duplicado é um defeito de alto custo.
- **Correção sugerida:** Documentar explicitamente a garantia esperada e, idealmente, passar uma chave de idempotência. O `Order` já carrega `idempotencyKey` e `id`, então o adapter pode usá-los — mas isso deve estar no contrato:
  ```ts
  export interface ErpPort {
    /**
     * Fatura o pedido no ERP. DEVE ser idempotente por `order.idempotencyKey`:
     * múltiplas chamadas com a mesma chave retornam o mesmo `erpInvoiceId`
     * e nunca geram fatura duplicada. Lança em falha (timeout/erro do ERP).
     */
    invoice(order: Order): Promise<{ erpInvoiceId: string }>;
  }
  ```

### LOW-2 — Tipo de retorno inline e não nomeado
- **Local:** linha 11 (`Promise<{ erpInvoiceId: string }>`)
- **Descrição:** O shape de retorno `{ erpInvoiceId: string }` é declarado inline. Ele é repetido em três pontos do código (`erp.port.ts`, `fake-erp.client.ts` linha 37, `checkout.worker.ts` linha 125 e a desestruturação na 80). Compare com `stock.port.ts`, que nomeia `ReserveOutcome` para um padrão equivalente. Um tipo nomeado deixa a porta mais coesa e facilita evolução (ex.: adicionar `invoicedAt`).
- **Impacto:** Manutenibilidade: mudança no shape exige editar várias assinaturas inline; menor consistência com as demais portas do projeto.
- **Correção sugerida:**
  ```ts
  export interface ErpInvoiceResult {
    erpInvoiceId: string;
  }
  export interface ErpPort {
    invoice(order: Order): Promise<ErpInvoiceResult>;
  }
  ```

### LOW-3 — Contrato de erro não tipado / não documentado de forma acionável
- **Local:** linhas 10-11 (JSDoc "Throws on failure")
- **Descrição:** O JSDoc diz que o método "lança em falha", mas não define um tipo de erro do domínio/aplicação para a porta. O adapter atual lança `ErpInvoiceError`, definido dentro de `infrastructure/erp/fake-erp.client.ts`. Como a porta pertence à camada de aplicação e o erro é parte do contrato observável (o worker faz `catch (err)` e loga `(err as Error).message`), o tipo de erro idealmente deveria ser conhecido na fronteira da porta, não só na infra. Hoje o worker depende apenas de `Error`, o que é frágil se algum dia precisar distinguir falha transitória (retentável) de permanente (não retentável).
- **Impacto:** Acoplamento implícito: distinção entre erro retentável e fatal não é expressável pelo contrato; o `as Error` no worker (linha 93) é uma asserção que pode esconder rejeições que não são `Error`. Decisões de retry/backoff ficam sem base contratual.
- **Correção sugerida:** Definir um erro de contrato na camada de aplicação (ex.: `ErpInvoiceError` com flag `retryable`) e referenciá-lo no JSDoc da porta, para que adapters o reutilizem e o worker possa decidir retry com base no tipo, e não só na contagem de tentativas.

### LOW-4 — Ausência de cancelamento/timeout no contrato
- **Local:** linha 11
- **Descrição:** O caso de estudo descreve o ERP como "lento para faturar" (offender #3). O contrato `invoice(order)` não recebe `AbortSignal` nem documenta política de timeout, deixando cada adapter livre para travar indefinidamente. O `FakeErpClient` usa `setTimeout` limitado, mas um cliente HTTP real sem timeout poderia segurar o worker e inflar `queueDepth`.
- **Impacto:** Em produção, uma chamada ERP sem timeout pode bloquear workers e degradar a fila — exatamente o sintoma que a arquitetura busca mitigar. Baixa severidade aqui por ser apenas a definição da porta, mas é o ponto certo para fixar a expectativa.
- **Correção sugerida:** Considerar `invoice(order: Order, signal?: AbortSignal)` ou documentar no JSDoc que adapters DEVEM impor timeout e lançar em estouro, mantendo a semântica "lança em falha" coerente com o retry do worker.

---

## Pontos positivos

- **Aderência hexagonal exemplar:** a porta importa apenas `Order` do domínio; zero vazamento de infraestrutura (sem tipos HTTP, Redis, ERP-específicos). Direção de dependência correta (aplicação → domínio).
- **Token de DI via `Symbol`:** `ERP_PORT = Symbol('ERP_PORT')` é o padrão idiomático NestJS para injeção por interface, consistente com `STOCK_PORT`, `QUEUE_PORT`, etc.
- **Superfície mínima:** uma única responsabilidade (faturar), o que mantém a porta fácil de implementar/mockar e reduz acoplamento.
- **JSDoc presente:** comenta a semântica de erro ("Throws on failure") e contextualiza o papel no caso de estudo, ajudando quem implementa um adapter real.
- **Retorno explícito do `erpInvoiceId`:** evita estados opacos; o worker registra a fatura na `history` do pedido (rastreabilidade).

---

## Veredito

**Aprovado.**

O arquivo está correto, idiomático e fiel à arquitetura hexagonal. Não há achados CRITICAL/HIGH/MEDIUM. Os quatro pontos LOW são melhorias de robustez contratual (idempotência, tipo de retorno nomeado, contrato de erro tipado e timeout/cancelamento) que valem a pena considerar antes de plugar um adapter ERP real, mas não bloqueiam o merge.
