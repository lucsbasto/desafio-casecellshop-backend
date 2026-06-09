# PROJECT — CaseCellShop Backend Challenge (Pleno)

## Vision
Entregar a solução do desafio técnico Pleno Backend da CaseCellShop: um serviço backend
pequeno, executável e bem fundamentado que demonstra raciocínio de backend pleno em
**cache**, **observabilidade**, **consistência de estoque/concorrência**, **resiliência
assíncrona** e **contrato de API**, acompanhado das respostas conceituais (Parte 1.A).

Empresa fictícia de capinhas de celular em hipercrescimento (milhares → milhões de acessos).
Três ofensores: (1) performance da vitrine, (2) consistência de estoque/overselling,
(3) resiliência do checkout (faturamento lento no ERP).

## Goals (o que é avaliado)
- **Clareza na análise** dos 3 problemas, impactos e trade-offs.
- **Cache**: TTL, invalidação, fallback, prevenção de dados obsoletos e cache stampede.
- **Observabilidade**: logs estruturados, métricas (counter/gauge/histogram), traces/spans,
  SLI/SLO, alerta e dashboard (Datadog conceitual).
- **Consistência de estoque**: atomic update / lock / reserva; idempotência; concorrência.
- **Resiliência assíncrona**: retry, status de pedido, reconciliação simples.
- **Entrega**: testes, contrato OpenAPI, organização, uso responsável de IA (PROMPTS.md).

## Non-Goals
Autenticação, pagamento real, deploy, front-end, integração real com ERP. Tudo
local/simulado. Simplificações documentadas no README.

## Deliverables
1. **Parte 1.A** — `docs/RESPOSTAS-CONCEITUAIS.md` (5 perguntas, em PT-BR).
2. **Parte 1.B** — serviço NestJS + TypeScript executável.
3. `README.md` — decisões, trade-offs, limitações, como rodar, runbook/alerta/dashboard.
4. OpenAPI (gerado via @nestjs/swagger + `openapi.json` exportado).
5. `PROMPTS.md` — prompts de IA relevantes.
6. Repositório git com commits atômicos (push pelo candidato).

## Stack (decisões)
- **NestJS + TypeScript** (maturidade arquitetural, DI, módulos, Swagger nativo).
- **Cache**: Redis (`ioredis`) em produção; adapter in-memory para testes.
- **Fila/worker**: **BullMQ** (Redis) em produção; adapter in-memory para testes.
- **Observabilidade**: `nestjs-pino` (logs), `prom-client` (/metrics), OpenTelemetry spans.
- **Infra local**: `docker-compose.yml` (redis + app). Docker não disponível na máquina de
  desenvolvimento → arquitetura ports/adapters garante testes sem Docker.
