param(
  [string]$Port,
  [string]$Environment = "esp32dev"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$FirmwareDir = Join-Path $Root "firmware"

$args = @("-m", "platformio", "run", "-d", $FirmwareDir, "-e", $Environment, "-t", "upload")
if ($Port) {
  $args += @("--upload-port", $Port)
}

python @args
exit $LASTEXITCODE
