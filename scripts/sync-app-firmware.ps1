param()

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root "web\flasher"
$Target = Join-Path $Root "app\public\flasher"

foreach ($required in @($Source, (Join-Path $Source "manifest.json"), (Join-Path $Source "firmware"))) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing firmware bundle artifact: $required"
  }
}

Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $Source "*") -Destination $Target -Recurse -Force
Remove-Item -LiteralPath (Join-Path $Target ".server.pid") -Force -ErrorAction SilentlyContinue

"App firmware bundle synced: $Target"
