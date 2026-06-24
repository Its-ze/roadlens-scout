param(
  [string[]]$Environment = @("esp32dev", "esp32s3", "esp32c3")
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$FirmwareDir = Join-Path $Root "firmware"
$FlasherDir = Join-Path $Root "web\flasher"
$FlasherFirmwareDir = Join-Path $FlasherDir "firmware"
$BuildRoot = Join-Path $env:TEMP "roadlens-scout-pio-build"

New-Item -ItemType Directory -Force -Path $FlasherFirmwareDir | Out-Null
Remove-Item -LiteralPath $FlasherFirmwareDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $FlasherFirmwareDir | Out-Null
Remove-Item -LiteralPath $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null

$targets = @{
  esp32dev = @{
    ChipFamily = "ESP32"
    Folder = "esp32"
    Label = "ESP32 / ESP32-WROOM / ESP32-WROVER"
  }
  esp32s3 = @{
    ChipFamily = "ESP32-S3"
    Folder = "esp32s3"
    Label = "ESP32-S3"
  }
  esp32c3 = @{
    ChipFamily = "ESP32-C3"
    Folder = "esp32c3"
    Label = "ESP32-C3"
  }
}

$bootApp0 = Join-Path $env:USERPROFILE ".platformio\packages\framework-arduinoespressif32\tools\partitions\boot_app0.bin"
if (-not (Test-Path -LiteralPath $bootApp0)) {
  $bootApp0 = Get-ChildItem -Path (Join-Path $env:USERPROFILE ".platformio\packages") -Filter "boot_app0.bin" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $bootApp0 -or -not (Test-Path -LiteralPath $bootApp0)) {
  throw "Could not locate boot_app0.bin in PlatformIO packages."
}

$builds = @()
foreach ($envName in $Environment) {
  if (-not $targets.ContainsKey($envName)) {
    $known = ($targets.Keys | Sort-Object) -join ", "
    throw "Unknown firmware environment '$envName'. Known environments: $known"
  }

  $target = $targets[$envName]
  $targetDir = Join-Path $FlasherFirmwareDir $target.Folder
  $buildDir = Join-Path $BuildRoot $envName
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $previousBuildDir = $env:PLATFORMIO_BUILD_DIR
  $env:PLATFORMIO_BUILD_DIR = $BuildRoot
  try {
    python -m platformio run -d $FirmwareDir -e $envName
  } finally {
    if ($null -eq $previousBuildDir) {
      Remove-Item Env:\PLATFORMIO_BUILD_DIR -ErrorAction SilentlyContinue
    } else {
      $env:PLATFORMIO_BUILD_DIR = $previousBuildDir
    }
  }
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $required = @(
    @{ Name = "bootloader.bin"; Source = Join-Path $buildDir "bootloader.bin" },
    @{ Name = "partitions.bin"; Source = Join-Path $buildDir "partitions.bin" },
    @{ Name = "firmware.bin"; Source = Join-Path $buildDir "firmware.bin" },
    @{ Name = "boot_app0.bin"; Source = $bootApp0 }
  )

  foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath $item.Source)) {
      throw "Missing build artifact for $envName`: $($item.Source)"
    }
    Copy-Item -LiteralPath $item.Source -Destination (Join-Path $targetDir $item.Name) -Force
  }

  $folder = $target.Folder
  $builds += [ordered]@{
    chipFamily = $target.ChipFamily
    parts = @(
      [ordered]@{ path = "firmware/$folder/bootloader.bin"; offset = 0x1000 },
      [ordered]@{ path = "firmware/$folder/partitions.bin"; offset = 0x8000 },
      [ordered]@{ path = "firmware/$folder/boot_app0.bin"; offset = 0xe000 },
      [ordered]@{ path = "firmware/$folder/firmware.bin"; offset = 0x10000 }
    )
  }
}

$manifest = [ordered]@{
  name = "RoadLens Scout ESP32 Sensor"
  version = "0.1.9"
  new_install_prompt_erase = $true
  builds = $builds
}

$manifestPath = Join-Path $FlasherDir "manifest.json"
$json = $manifest | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)

Get-ChildItem -LiteralPath $FlasherFirmwareDir -Filter "*.bin" -Recurse |
  Sort-Object FullName |
  ForEach-Object {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
    $relative = Resolve-Path -LiteralPath $_.FullName -Relative
    "{0}  {1}" -f $hash.Hash.ToLowerInvariant(), $relative
  }

"Flasher manifest: $manifestPath"
