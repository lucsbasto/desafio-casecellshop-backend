# Code Review — src/interface/http/guards/admin-token.guard.ts

Guard de bearer-token mínimo que protege endpoints operacionais destrutivos (reconciliação: liberação de estoque, re-enfileiramento de jobs). A lógica é simples e legível, mas concentra duas fraquezas de segurança relevantes (fail-open silencioso-ish e comparação de token não constant-time) e algumas arestas de parsing/robustez que merecem ajuste antes de considerar produção.

| Severidade | Quantidade |
|------------|------------|
| CRITICAL   | 0          |
| HIGH       | 2          |
| MEDIUM     | 2          |
| LOW        | 3          |

---

## HIGH

### H1 — Comparação de token não é constant-time (timing attack)
- **Local:** linha 34 (`token !== expected`)
- **Descrição:** A comparação do token usa o operador `!==` de string do JavaScript, que faz *short-circuit* no primeiro byte divergente. Isso vaza, via tempo de resposta, o tamanho do prefixo correto adivinhado, permitindo a um atacante reconstruir o token byte a byte.
- **Impacto:** Este guard é a única barreira de um endpoint **destrutivo** (`POST /admin/reconcile` → libera estoque e re-enfileira jobs). Um bypass de autenticação aqui é de alta gravidade. Embora timing attacks remotos sejam difíceis na prática (jitter de rede), para um segredo de autorização a defesa correta é barata e padrão.
- **Correção sugerida:** Usar comparação de tempo constante com `crypto.timingSafeEqual`, protegendo também contra a diferença de comprimento (o `timingSafeEqual` lança se os buffers tiverem tamanhos diferentes):

```ts
import { timingSafeEqual } from 'node:crypto';

private safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
// ...
if (scheme !== 'Bearer' || !token || !this.safeEqual(token, expected)) {
  throw new UnauthorizedException('Token admin inválido ou ausente');
}
```

### H2 — Fail-open: ausência de `ADMIN_TOKEN` libera endpoints destrutivos
- **Local:** linhas 25-29 (`if (!expected) { ... return true; }`)
- **Descrição:** Quando `ADMIN_TOKEN` não está definido (ou é string vazia), o guard registra um `warn` e libera o acesso (`return true`). O fail-open vale também para *whitespace-only* (`ADMIN_TOKEN=" "` é truthy, mas é claramente uma configuração incorreta que passaria a "proteger" com um token de espaço).
- **Impacto:** Em produção, um deploy com a variável esquecida/typada deixa o endpoint destrutivo totalmente aberto, dependendo apenas de alguém ler logs para perceber. O comentário do arquivo reconhece isso ("demo frictionless"), porém o comportamento padrão é o oposto do *secure-by-default*. O `warn` é logado **a cada request**, não "uma vez" como o docstring afirma (ver L1).
- **Impacto:** O risco é mitigável por configuração, mas o padrão deveria ser fechar em produção. Sugestão: tornar o fail-open explícito e condicionado ao ambiente.
- **Correção sugerida:** Fechar (fail-closed) quando `NODE_ENV === 'production'`, e exigir um opt-in explícito para o modo aberto:

```ts
const expected = process.env.ADMIN_TOKEN?.trim();
if (!expected) {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    throw new UnauthorizedException('Admin endpoint desabilitado: ADMIN_TOKEN não configurado');
  }
  this.warnOnce(); // ver L1
  return true;
}
```

---

## MEDIUM

### M1 — Parsing do header `Authorization` frágil (múltiplos espaços / tokens com espaço)
- **Local:** linha 33 (`const [scheme, token] = header.split(' ')`)
- **Descrição:** `header.split(' ')` quebra em **todos** os espaços. Se o cliente enviar `Bearer  <token>` (dois espaços, comum em alguns proxies/ferramentas), `token` vira string vazia e `scheme`/`token` desalinham. Tokens não deveriam conter espaços, mas o split também ignora o restante do array silenciosamente.
- **Impacto:** Rejeição de requisições legítimas (falso negativo) em casos de formatação levemente fora do padrão; comportamento de parsing pouco previsível. Não é falha de segurança direta, mas afeta correção/robustez.
- **Correção sugerida:** Fazer split limitado e validar explicitamente:

```ts
const header = req.headers.authorization ?? '';
const match = /^Bearer (.+)$/.exec(header.trim());
const token = match?.[1];
if (!token || !this.safeEqual(token, expected)) {
  throw new UnauthorizedException('Token admin inválido ou ausente');
}
```

### M2 — Header `authorization` pode ser array (`string[]`) e quebrar o `.split`
- **Local:** linha 32 (`const header = req.headers.authorization ?? ''`)
- **Descrição:** No tipo do Express, `req.headers.authorization` é `string | undefined`, mas headers duplicados podem, em cenários de baixo nível, ser entregues como array. Mais relevante: o tipo é tratado como sempre-string e `.split` é chamado sem verificação. Se por proxy/configuração o valor não for string, `.split` lança `TypeError`, que vira 500 em vez de 401.
- **Impacto:** Um cliente conseguiria provocar erro 500 (em vez de 401) enviando o header duplicado — diferença de tratamento de erro e possível ruído em observabilidade/alerta. Baixa probabilidade no Express padrão, porém trivial de blindar.
- **Correção sugerida:** Normalizar para string antes de processar: `const raw = req.headers.authorization; const header = Array.isArray(raw) ? raw[0] : (raw ?? '');`. A regex sugerida em M1 já elimina a chamada direta a `.split`.

---

## LOW

### L1 — Docstring afirma "logs a warning once", mas o warn é por-request
- **Local:** linhas 16-17 (comentário) vs. linha 27 (`this.logger.warn(...)`)
- **Descrição:** O comentário diz que o estado aberto "logs a warning once so the open state is never silent". Na prática, `canActivate` roda a cada requisição, então o warning é emitido **a cada chamada** ao endpoint admin, não uma vez.
- **Impacto:** Documentação enganosa e potencial poluição de logs (log spam) se o endpoint for chamado em loop. Divergência entre intenção e implementação.
- **Correção sugerida:** Implementar o "once" de fato (flag `private warnedOpenState = false;`) ou corrigir o comentário. Ex.:

```ts
private warnedOpenState = false;
private warnOnce(): void {
  if (this.warnedOpenState) return;
  this.warnedOpenState = true;
  this.logger.warn('ADMIN_TOKEN não configurado: endpoints admin estão SEM proteção');
}
```

### L2 — `process.env` lido diretamente no guard (vazamento de infra, dificulta teste)
- **Local:** linha 25 (`process.env.ADMIN_TOKEN`)
- **Descrição:** O guard acessa `process.env` diretamente em vez de receber o segredo via DI (`ConfigService`). Em arquitetura hexagonal/NestJS idiomático, configuração é uma dependência injetada, não um acesso global a ambiente dentro da regra.
- **Impacto:** Acoplamento a estado global, testes precisam mutar `process.env` (frágil, ordem-dependente), e a config não é validada/centralizada. Para um guard de borda é aceitável, mas foge ao padrão do projeto se ele usa `ConfigService`/validação de env em outros pontos.
- **Correção sugerida:** Injetar `ConfigService` e ler `config.get<string>('ADMIN_TOKEN')`, idealmente com schema de validação na inicialização do app.

### L3 — Ausência de testes para o guard
- **Local:** arquivo inteiro (não existe `admin-token.guard.spec.ts`)
- **Descrição:** Sendo a única proteção de um endpoint destrutivo, o guard não possui teste unitário cobrindo: token válido (allow), token inválido (401), header ausente (401), scheme errado (401) e o caminho fail-open sem `ADMIN_TOKEN`.
- **Impacto:** Regressões de segurança (ex.: alguém inverter uma condição) passariam despercebidas. Comportamento de borda crítico sem rede de segurança.
- **Correção sugerida:** Adicionar `admin-token.guard.spec.ts` com um `ExecutionContext` mockado cobrindo os cinco cenários acima, incluindo o fail-open condicionado a ambiente (após H2).

---

## Pontos positivos
- **Responsabilidade única e clara:** o guard faz exatamente uma coisa (autenticação por bearer-token), com docstring que explica o propósito, o trade-off do modo aberto e a recomendação de produção.
- **Uso idiomático de NestJS:** `implements CanActivate`, `@Injectable()`, `Logger` por classe, e `UnauthorizedException` (mapeada corretamente para 401) em vez de retorno booleano ambíguo no caminho de falha.
- **Validação correta de scheme + token:** verifica tanto o esquema `Bearer` quanto o valor do token, e usa `?? ''` para evitar `undefined` no caso comum de header ausente.
- **Honestidade sobre o escopo:** o comentário deixa explícito que isto é um guard mínimo de demo e que produção exigiria authn/authz real — boa sinalização de dívida técnica consciente.
- **Sem `any`, sem asserções de tipo inseguras, sem catch vazio:** código limpo e tipado (`getRequest<Request>()`).

---

## Veredito

**Aprovado com ressalvas.**

A estrutura está sólida e idiomática, mas as duas questões HIGH (comparação não constant-time e fail-open não condicionado a produção) tocam diretamente a segurança da única barreira de um endpoint destrutivo e devem ser corrigidas antes de qualquer uso fora de demo. As questões MEDIUM (robustez de parsing) e LOW (docstring divergente, leitura direta de env, ausência de testes) são de baixo custo e recomendadas para fechar o conjunto. Nenhum achado é bloqueante para o contexto explícito de demo, dado o comentário que assume o trade-off — daí "aprovado com ressalvas" e não "requer mudanças".
