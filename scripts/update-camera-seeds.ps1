param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Root "scripts\update-camera-seeds.py"

python $Script
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
