param()

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root "web\flasher"
$Target = Join-Path $Root "app\public\flasher"
$DataDir = Join-Path $Root "data"
$AppPublic = Join-Path $Root "app\public"

foreach ($required in @($Source, (Join-Path $Source "manifest.json"), (Join-Path $Source "firmware"))) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing firmware bundle artifact: $required"
  }
}

Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $Source "*") -Destination $Target -Recurse -Force
Remove-Item -LiteralPath (Join-Path $Target ".server.pid") -Force -ErrorAction SilentlyContinue

foreach ($dataFile in @("signatures.json", "camera-seeds.json")) {
  $sourceFile = Join-Path $DataDir $dataFile
  if (Test-Path -LiteralPath $sourceFile) {
    Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $AppPublic $dataFile) -Force
  }
}

"App firmware bundle synced: $Target"
