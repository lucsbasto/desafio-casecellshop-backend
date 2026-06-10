#!/usr/bin/env bash
# Renderiza todos os .mmd deste diretório para .svg usando mermaid-cli (via npx).
# Uso:  ./render.sh
# Requer: Node.js + npx. O npx baixa @mermaid-js/mermaid-cli e o Chromium na 1ª execução.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$dir"

shopt -s nullglob
mmds=(*.mmd)
if [ ${#mmds[@]} -eq 0 ]; then
    echo "Nenhum arquivo .mmd encontrado em $dir"
    exit 1
fi

# Se houver puppeteer.json (ex.: para apontar a um Chrome já instalado), usa-o.
puppeteer_args=()
if [ -f "puppeteer.json" ]; then
    puppeteer_args=(-p puppeteer.json)
    echo "Usando puppeteer.json (Chrome local)."
fi

for f in "${mmds[@]}"; do
    out="${f%.mmd}.svg"
    echo "Renderizando $f -> $out"
    if ! npx -y @mermaid-js/mermaid-cli "${puppeteer_args[@]}" -i "$f" -o "$out" -b transparent; then
        echo "AVISO: falha ao renderizar $f" >&2
    fi
done

echo "Concluído."
