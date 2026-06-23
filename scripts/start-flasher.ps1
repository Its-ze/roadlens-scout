param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$FlasherDir = Join-Path $Root "web\flasher"
$ManifestPath = Join-Path $FlasherDir "manifest.json"

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  Write-Warning "No manifest found. Run scripts\build-firmware.ps1 first."
}

$process = Start-Process -FilePath "python" `
  -ArgumentList @("-m", "http.server", $Port, "--bind", "127.0.0.1") `
  -WorkingDirectory $FlasherDir `
  -WindowStyle Hidden `
  -PassThru

$pidPath = Join-Path $FlasherDir ".server.pid"
Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII

"RoadLens Scout flasher: http://127.0.0.1:$Port/"
"PID: $($process.Id)"
