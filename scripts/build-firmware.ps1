param(
  [string]$Environment = "esp32dev"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$FirmwareDir = Join-Path $Root "firmware"
$FlasherDir = Join-Path $Root "web\flasher"
$FlasherFirmwareDir = Join-Path $FlasherDir "firmware"
$BuildDir = Join-Path $FirmwareDir ".pio\build\$Environment"

New-Item -ItemType Directory -Force -Path $FlasherFirmwareDir | Out-Null

python -m platformio run -d $FirmwareDir -e $Environment
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$required = @(
  @{ Name = "bootloader.bin"; Source = Join-Path $BuildDir "bootloader.bin" },
  @{ Name = "partitions.bin"; Source = Join-Path $BuildDir "partitions.bin" },
  @{ Name = "firmware.bin"; Source = Join-Path $BuildDir "firmware.bin" }
)

$bootApp0 = Join-Path $env:USERPROFILE ".platformio\packages\framework-arduinoespressif32\tools\partitions\boot_app0.bin"
if (-not (Test-Path -LiteralPath $bootApp0)) {
  $bootApp0 = Get-ChildItem -Path (Join-Path $env:USERPROFILE ".platformio\packages") -Filter "boot_app0.bin" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $bootApp0 -or -not (Test-Path -LiteralPath $bootApp0)) {
  throw "Could not locate boot_app0.bin in PlatformIO packages."
}

$required += @{ Name = "boot_app0.bin"; Source = $bootApp0 }

foreach ($item in $required) {
  if (-not (Test-Path -LiteralPath $item.Source)) {
    throw "Missing build artifact: $($item.Source)"
  }
  Copy-Item -LiteralPath $item.Source -Destination (Join-Path $FlasherFirmwareDir $item.Name) -Force
}

$manifest = [ordered]@{
  name = "RoadLens Scout ESP32 Sensor"
  version = "0.1.0"
  new_install_prompt_erase = $true
  builds = @(
    [ordered]@{
      chipFamily = "ESP32"
      parts = @(
        [ordered]@{ path = "firmware/bootloader.bin"; offset = 0x1000 },
        [ordered]@{ path = "firmware/partitions.bin"; offset = 0x8000 },
        [ordered]@{ path = "firmware/boot_app0.bin"; offset = 0xe000 },
        [ordered]@{ path = "firmware/firmware.bin"; offset = 0x10000 }
      )
    }
  )
}

$manifestPath = Join-Path $FlasherDir "manifest.json"
$json = $manifest | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)

Get-ChildItem -LiteralPath $FlasherFirmwareDir -Filter "*.bin" |
  Sort-Object Name |
  ForEach-Object {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
    "{0}  {1}" -f $hash.Hash.ToLowerInvariant(), $_.Name
  }

"Flasher manifest: $manifestPath"
