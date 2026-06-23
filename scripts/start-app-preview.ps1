param(
  [int]$Port = 5177
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root "app"

Push-Location $AppDir
try {
  if (-not (Test-Path -LiteralPath "node_modules")) {
    npm install
  }
  npm run dev -- --port $Port
} finally {
  Pop-Location
}
