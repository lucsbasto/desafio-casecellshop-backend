# Sumário Executivo — Design Patterns (CaseCellShop Backend)

Backend NestJS/TypeScript para uma loja de capinhas, cujo núcleo é um **checkout assíncrono**: o request reserva estoque atomicamente, persiste o pedido `PENDING`, enfileira um job e responde `202 Accepted`; um worker fatura no ERP (lento/instável) com retry/backoff e, ao esgotar as tentativas, compensa o estoque (`FAILED`). A tese arquitetural central é simples e consistente: **Arquitetura Hexagonal (Ports & Adapters) + Injeção de Dependência** como base que sustenta um conjunto coeso de **padrões de confiabilidade** — toda capacidade de infra (estoque, fila, cache, idempotência, repo, ERP) é um *port* com duas implementações (in-memory e Redis/BullMQ) selecionadas por *factory* em runtime, atendendo ao requisito de rodar **sem Docker e com Redis** sem duplicar lógica de negócio.

## Os 5 padrões que mais importam neste sistema

| Padrão | Problema que resolve | Por que foi a escolha certa aqui |
|---|---|---|
| **Ports & Adapters + DI** | Acoplamento do domínio a framework/infra; necessidade de rodar sem deps externas **e** com Redis | Cada capability é um *port* (interface pura) com adapter in-memory e Redis trocáveis por factory de runtime (`infrastructure.module.ts`). A mesma regra de negócio roda em teste determinístico e em produção; domínio (`order.ts`) não conhece HTTP/Redis/Nest. |
| **Idempotência atômica** | Retry de rede e duplo-clique gerando pedidos/faturamentos duplicados | Dedupe na borda via Lua `SET NX PX`+`GET` (`redis-idempotency.adapter.ts`), primeiro passo do use case (`checkout.usecase.ts:88`); **e** worker idempotente que ignora estados terminais/`PROCESSING` (`checkout.worker.ts:57-69`). Defesa em profundidade → "exactly-once" prático. |
| **Reserva atômica anti-overselling (Lua / single-thread)** | Vender estoque que não existe sob concorrência inter-processo (TOCTOU) | `RESERVE_LUA` faz GET+compare+`DECRBY` como operação única no servidor Redis (`redis-stock.adapter.ts:13-20`); o in-memory usa seção crítica síncrona. Overselling impossível mesmo com N instâncias, com paridade conceitual memory↔redis. |
| **Outbox lógico + Reconciliação** | Pedido órfão se o `enqueue` falhar após persistir (mensagem-fantasma / ghost order) | Salva `PENDING` (source of truth) **antes** de enfileirar (`checkout.usecase.ts:127-145`); `ReconcileUseCase` + `@Interval(15000)` varrem PENDING órfãos e re-enfileiram ou compensam. Garante progresso sem banco transacional. |
| **Retry + Backoff + Compensação** | ERP intermitente; consistência entre estoque (Redis) e ERP sem transação distribuída | Retry exponencial nativo (BullMQ) e equivalente in-memory via `Strategy` reutilizável; ao esgotar tentativas, `onExhausted` → `FAILED` + `stock.release` (`checkout.worker.ts:100-123`). Estoque nunca fica preso; degrada graciosamente. |

## O que conscientemente NÃO fizemos (e por quê)

- **Circuit Breaker completo (Hystrix-style):** redundante — retry+backoff+teto+DLQ+compensação já absorvem falhas do único downstream assíncrono; breaker seria a próxima adição em produção.
- **ORM / persistência durável (TypeORM/Prisma):** requisito de rodar sem banco/Docker; repos são `Map` in-memory e o *port* preserva o swap mecânico para Postgres.
- **CQRS / Event Sourcing:** domínio pequeno; o `history[]` do agregado `Order` já dá auditoria event-log-like sem event store/projeções — over-engineering evitado.
- **OpenTelemetry SDK real + Distributed Lock cross-instance:** tracer com API OTel-compatível (swap direto) e single-flight in-process + TTL jitter; lock cross-instance documentado como próximo passo no próprio código.

**Fecho:** arquitetura **madura e coerente** — resolve o problema presente (checkout resiliente contra ERP instável) com os padrões certos e não-redundantes, deixando as omissões conscientes e os pontos parciais documentados no código, com os caminhos de evolução preservados pelos ports.

---

📄 Documento completo: [`../DESIGN-PATTERNS.md`](../DESIGN-PATTERNS.md) · 📊 Diagramas: [`../ARCHITECTURE-DIAGRAM.md`](../ARCHITECTURE-DIAGRAM.md)
