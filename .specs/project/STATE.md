# STATE — Memory

## Decisions
- **D1** Framework: **NestJS + TypeScript** (escolha do usuário; maturidade arquitetural).
- **D2** Cache + fila: **Redis real via Docker Compose** (escolha do usuário). Cache = ioredis,
  fila = BullMQ. Docker NÃO está instalado na máquina dev → adotada **arquitetura
  hexagonal (ports/adapters)**: domínio puro + adapters Redis (prod) e in-memory (test).
- **D3** Entrega: tudo (respostas conceituais 1.A + código 1.B + README + OpenAPI + PROMPTS.md).
- **D4** Git: `git init` local + commits atômicos; **usuário publica** no GitHub (não publicar
  em nome dele sem auth).
- **D5** Estoque atômico: produção usa Redis Lua/DECRBY condicional (reserva atômica);
  in-memory usa operação síncrona equivalente para testes de overselling.
- **D6** Idempotência: chave `Idempotency-Key` (header) no POST /checkout → store (Redis SETNX /
  in-memory) mapeando key→orderId; retry/duplo-clique retornam o mesmo pedido.
- **D7** Pedido-fantasma/mensagem-fantasma: gravar pedido (status PENDING) ANTES de enfileirar;
  enfileiramento é o "outbox" lógico; worker idempotente; reconciliação varre PENDING órfãos.

## Blockers
- **B1** Docker indisponível na máquina dev → caminho Redis não é testável end-to-end aqui.
  Mitigação: adapters in-memory + teste Redis opcional via env `REDIS_E2E=1`.

## Lessons
- PDF lido via `pdftotext` (Git for Windows): `C:\Program Files\Git\mingw64\bin\pdftotext.exe`.

## Todos
- [ ] Scaffold NestJS + config (build/test verde)
- [ ] Domínio: estoque/reserva + idempotência (puro, testado)
- [ ] Ports + adapters (cache, queue, repo, erp)
- [ ] Endpoints: GET /products, POST /checkout, GET /orders/:id/status
- [ ] Observabilidade: pino + prom-client + spans
- [ ] OpenAPI export
- [ ] Testes: unit (domínio) + integração (cache hit/miss, overselling, idempotência)
- [ ] docker-compose.yml + .env.example
- [ ] RESPOSTAS-CONCEITUAIS.md (5 perguntas)
- [ ] README + PROMPTS.md
- [ ] git init + commits atômicos

## Deferred Ideas
- Teste e2e real contra Redis em CI (GitHub Actions com service redis).

## Preferences
- Idioma: PT-BR. Delegar pesquisa web ao Gemini CLI quando necessário.
