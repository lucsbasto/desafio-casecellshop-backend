# PROMPTS.md — Uso de IA

Como pleno, a IA foi usada com critério: para acelerar scaffolding, redação de documentação e
geração de testes, **sempre com revisão crítica** das saídas. Nenhum código entrou sem ser
compilado, testado e entendido. Abaixo, os prompts e decisões relevantes.

## Ferramentas
- **Claude (Claude Code)**: orquestração, arquitetura, implementação do serviço, testes.
- Skill **tlc-spec-driven**: conduziu o fluxo Specify → Design → Tasks → Execute
  (artefatos em `.specs/`).

## Prompts relevantes (resumidos)

### 1. Enquadramento do desafio
> "Resolver o desafio Pleno Backend da CaseCellShop usando a skill tlc-spec-driven. Parte 1.A =
> 5 perguntas conceituais; Parte 1.B = serviço com GET /products (cache TTL), POST /checkout
> (202 assíncrono), GET /orders/{id}/status, OpenAPI, observabilidade, sem overselling,
> idempotência, worker simulando ERP, testes. Stack: Node + TypeScript."

Decisões tomadas a partir daqui (registradas em `.specs/project/STATE.md`):
- Framework **NestJS**; cache/fila **Redis + Docker Compose**; entrega completa (1.A + 1.B);
  `git init` local com o candidato publicando.

### 2. Conflito Docker × Redis (decisão de engenharia)
A máquina de desenvolvimento não tinha Docker. Em vez de abandonar o Redis, optou-se por
**arquitetura hexagonal**: adapters Redis (produção, via compose) e in-memory (testes), atrás
das mesmas portas. Isso permitiu testar a regra de negócio sem Docker e manter o Redis real
como runtime de produção.

### 3. Respostas conceituais (Parte 1.A)
> "Escreva as 5 respostas da Parte 1.A em PT-BR, técnicas, com tabelas de trade-offs e diagramas
> mermaid, **coerentes com a implementação** (NestJS, Redis cache-aside + Lua, BullMQ, pino,
> prom-client, OTel, OpenAPI)."

Saída revisada manualmente: corrigidas entidades HTML nos diagramas mermaid e alinhados os
nomes de métricas aos realmente expostos em `/metrics`.

### 4. Núcleo de consistência (o ponto mais sensível)
> "Implemente reserva de estoque atômica sem overselling: Redis Lua DECRBY condicional em
> produção e equivalente síncrono in-memory; prove com teste de N reservas concorrentes para
> estoque M<N."

Resultado: `stock-concurrency.spec.ts` (50 concorrentes / estoque 10 ⇒ 10 OK) e o fluxo de
checkout com idempotência por `Idempotency-Key`.

### 5. Resiliência assíncrona
> "Worker idempotente consumindo a fila, com retry/backoff; ao esgotar tentativas, FAILED +
> compensação de estoque; reconciliação de PENDING órfãos. Grave o pedido ANTES de enfileirar."

## Revisão humana aplicada
- Ajuste do conflito de tipos entre o `ioredis` de topo e o aninhado no BullMQ (passar URL de
  conexão ao BullMQ em vez da instância).
- Correção do harness de teste (semear o estoque, espelhando o `StockSeeder` do módulo Nest).
- Garantia de determinismo nos testes (ERP com `random` injetável; backoff 0 nos testes).
- Validação final: `npm run build` verde e **23 testes** passando.

## Princípio
IA acelera; a **responsabilidade de engenharia permanece humana**. Toda decisão de arquitetura,
trade-off e o entendimento do código são próprios — a IA foi instrumento, não autora final.
