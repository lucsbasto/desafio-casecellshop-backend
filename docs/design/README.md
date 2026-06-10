# docs/design — Material de apoio à arquitetura

Subpasta com os artefatos derivados da análise de design patterns. Os documentos-fonte ficam um nível acima: [`../DESIGN-PATTERNS.md`](../DESIGN-PATTERNS.md) (análise completa) e [`../ARCHITECTURE-DIAGRAM.md`](../ARCHITECTURE-DIAGRAM.md) (diagramas Mermaid inline).

## Conteúdo

| Arquivo | O que é | Para quem |
|---|---|---|
| [`SUMARIO-EXECUTIVO.md`](./SUMARIO-EXECUTIVO.md) | 1 página: os 5 padrões de maior impacto + o que conscientemente não foi feito | Avaliador com pouco tempo |
| [`EVOLUCAO-PRODUCAO.md`](./EVOLUCAO-PRODUCAO.md) | Dívidas conscientes e como evoluir cada uma para produção (decisão, porquê, quando quebra, próximo passo) | Discussão de escala/produção |
| [`DIAGRAMS.md`](./DIAGRAMS.md) | Os 5 diagramas como **SVG** portátil (renderizam em qualquer lugar) | Quem abre fora do GitHub/VS Code |
| [`CROSS-REFERENCE.md`](./CROSS-REFERENCE.md) | Índice cruzado: padrão ↔ diagrama ↔ arquivo de código | Navegação entre docs |
| [`CITATIONS-AUDIT.md`](./CITATIONS-AUDIT.md) | Auditoria das citações `arquivo:linha` (exatas/deslocadas) + patch sugerido | Manutenção da precisão |
| [`ACCURACY-CHECK.md`](./ACCURACY-CHECK.md) | Fact-check das afirmações dos docs contra o código | Manutenção da precisão |
| [`diagrams/`](./diagrams/) | Fontes `.mmd`, SVGs gerados, scripts `render.ps1`/`render.sh` e `puppeteer.json` | Regerar diagramas |

## Achados de manutenção (acionáveis)

Os relatórios de auditoria apontaram correções para os documentos-fonte. As principais:

- **Factual (resolvido):** a distinção dos "40ms" — latência do **repositório de catálogo** (`in-memory-product.repo.ts`), não do **ERP** (que usa 50–300ms, `ERP_MIN/MAX_LATENCY_MS`) — já foi aplicada em `DESIGN-PATTERNS §18`. Histórico em [`ACCURACY-CHECK.md`](./ACCURACY-CHECK.md).
- **Diagrama:** o nó `REPOSITORY_PORT` (Hexagonal §1) representa dois tokens reais — `ORDER_REPO_PORT` e `PRODUCT_REPO_PORT` (simplificação didática).
- **Citações:** ~18 referências `arquivo:linha` deslocaram 1–4 linhas por edições não commitadas; `requireRedis()` está em `infrastructure.module.ts`, não em `redis.provider.ts`. Patch pronto em [`CITATIONS-AUDIT.md`](./CITATIONS-AUDIT.md) — recomenda-se migrar para referência por **símbolo** (não envelhece).

## Nota sobre `diagrams/puppeteer.json`

Aponta para um caminho de Chrome **específico desta máquina** (`C:/Program Files/Google/Chrome/...`). Em outra máquina, ajuste o `executablePath` ou apague o arquivo (o mermaid-cli então baixa o próprio Chromium). Os scripts de render usam o `puppeteer.json` apenas se ele existir.
