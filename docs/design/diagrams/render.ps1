# Renderiza todos os .mmd deste diretório para .svg usando mermaid-cli (via npx).
# Uso:  pwsh ./render.ps1   (ou)   powershell -File render.ps1
# Requer: Node.js + npx. O npx baixa @mermaid-js/mermaid-cli e o Chromium na 1ª execução.

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$mmds = Get-ChildItem -Path $dir -Filter *.mmd | Sort-Object Name
if (-not $mmds) {
    Write-Host "Nenhum arquivo .mmd encontrado em $dir"
    exit 1
}

# Se houver puppeteer.json (ex.: para apontar a um Chrome ja instalado), usa-o.
$puppeteerArgs = @()
if (Test-Path "$dir/puppeteer.json") {
    $puppeteerArgs = @("-p", "$dir/puppeteer.json")
    Write-Host "Usando puppeteer.json (Chrome local)."
}

foreach ($f in $mmds) {
    $out = [System.IO.Path]::ChangeExtension($f.FullName, ".svg")
    Write-Host "Renderizando $($f.Name) -> $([System.IO.Path]::GetFileName($out))"
    npx -y @mermaid-js/mermaid-cli @puppeteerArgs -i $f.FullName -o $out -b transparent
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Falha ao renderizar $($f.Name) (exit $LASTEXITCODE)"
    }
}

Write-Host "Concluído."
