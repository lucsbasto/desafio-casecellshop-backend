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

for f in "${mmds[@]}"; do
    out="${f%.mmd}.svg"
    echo "Renderizando $f -> $out"
    if ! npx -y @mermaid-js/mermaid-cli -i "$f" -o "$out"; then
        echo "AVISO: falha ao renderizar $f" >&2
    fi
done

echo "Concluído."
