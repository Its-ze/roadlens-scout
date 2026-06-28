param(
  [string]$ApkPath,
  [string]$Version
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Package = Get-Content -LiteralPath (Join-Path $Root "app\package.json") -Raw | ConvertFrom-Json
if (-not $Version) {
  $Version = [string]$Package.version
}

if (-not $ApkPath) {
  $ApkPath = Join-Path $Root "app\android\app\build\outputs\apk\debug\app-debug.apk"
}

$FlasherSource = Join-Path $Root "web\flasher"
$DocsDir = Join-Path $Root "docs"
$DocsFlasher = Join-Path $DocsDir "flasher"
$DocsDownloads = Join-Path $DocsDir "downloads"
$DocsAssets = Join-Path $DocsDir "assets"
$BrandMark = Join-Path $Root "assets\brand\roadlens-mark.svg"
$SignatureSource = Join-Path $Root "data\signatures.json"
$CameraSeedSource = Join-Path $Root "data\camera-seeds.json"
$ApkName = "roadlens-scout-v$Version-debug.apk"
$ApkReleaseUrl = "https://github.com/Its-ze/roadlens-scout/releases/download/v$Version/$ApkName"

foreach ($required in @($FlasherSource, (Join-Path $FlasherSource "manifest.json"), (Join-Path $FlasherSource "firmware"), $ApkPath, $BrandMark, $SignatureSource, $CameraSeedSource)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing required Pages artifact: $required"
  }
}

New-Item -ItemType Directory -Force -Path $DocsDir, $DocsFlasher, $DocsDownloads, $DocsAssets | Out-Null
Remove-Item -LiteralPath $DocsFlasher -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DocsFlasher | Out-Null
Copy-Item -Path (Join-Path $FlasherSource "*") -Destination $DocsFlasher -Recurse -Force
Remove-Item -LiteralPath (Join-Path $DocsFlasher ".server.pid") -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $BrandMark -Destination (Join-Path $DocsAssets "roadlens-mark.svg") -Force
Copy-Item -LiteralPath $SignatureSource -Destination (Join-Path $DocsDir "signatures.json") -Force
Copy-Item -LiteralPath $CameraSeedSource -Destination (Join-Path $DocsDir "camera-seeds.json") -Force

$apkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ApkPath).Hash.ToLowerInvariant()
$apkItem = Get-Item -LiteralPath $ApkPath
$signaturePath = Join-Path $DocsDir "signatures.json"
$signatureItem = Get-Item -LiteralPath $signaturePath
$signatureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $signaturePath).Hash.ToLowerInvariant()
$signatureFeed = Get-Content -LiteralPath $signaturePath -Raw | ConvertFrom-Json
$cameraSeedPath = Join-Path $DocsDir "camera-seeds.json"
$cameraSeedItem = Get-Item -LiteralPath $cameraSeedPath
$cameraSeedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $cameraSeedPath).Hash.ToLowerInvariant()
$cameraSeedFeed = Get-Content -LiteralPath $cameraSeedPath -Raw | ConvertFrom-Json
$manifestPath = Join-Path $DocsFlasher "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$firmwareFiles = Get-ChildItem -LiteralPath (Join-Path $DocsFlasher "firmware") -Filter "*.bin" -Recurse |
  Sort-Object FullName

if (-not $firmwareFiles) {
  throw "No firmware binaries found under $DocsFlasher\firmware"
}

$firmwareBuilds = @()
foreach ($build in @($manifest.builds)) {
  $appPart = @($build.parts) | Where-Object { $_.path -match '/firmware\.bin$' } | Select-Object -First 1
  if (-not $appPart) {
    continue
  }
  $appPath = Join-Path $DocsFlasher ($appPart.path -replace '/', '\')
  if (-not (Test-Path -LiteralPath $appPath)) {
    throw "Manifest references missing firmware binary: $($appPart.path)"
  }
  $appItem = Get-Item -LiteralPath $appPath
  $firmwareBuilds += [ordered]@{
    chipFamily = $build.chipFamily
    path = "flasher/$($appPart.path)"
    bytes = $appItem.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash.ToLowerInvariant()
  }
}

$primaryFirmware = $firmwareBuilds | Where-Object { $_.chipFamily -eq "ESP32" } | Select-Object -First 1
if (-not $primaryFirmware) {
  $primaryFirmware = $firmwareBuilds | Select-Object -First 1
}

$checksumLines = @("$apkHash  $ApkReleaseUrl")
$checksumLines += "$signatureHash  signatures.json"
$checksumLines += "$cameraSeedHash  camera-seeds.json"
foreach ($file in $firmwareFiles) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  $relative = $file.FullName.Substring($DocsDir.Length + 1).Replace('\', '/')
  $checksumLines += "$hash  $relative"
}
$checksumText = $checksumLines -join "`n"
[System.IO.File]::WriteAllText((Join-Path $DocsDownloads "checksums.txt"), $checksumText + "`n", [System.Text.UTF8Encoding]::new($false))

$meta = [ordered]@{
  name = "RoadLens Scout"
  version = $Version
  generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  apk = [ordered]@{
    path = $ApkReleaseUrl
    asset = $ApkName
    bytes = $apkItem.Length
    sha256 = $apkHash
  }
  firmware = [ordered]@{
    manifest = "flasher/manifest.json"
    path = $primaryFirmware.path
    bytes = $primaryFirmware.bytes
    sha256 = $primaryFirmware.sha256
    builds = $firmwareBuilds
  }
  signatures = [ordered]@{
    path = "signatures.json"
    version = [string]$signatureFeed.version
    bytes = $signatureItem.Length
    sha256 = $signatureHash
    wifiPrefixes = @($signatureFeed.wifiPrefixes).Count
    blePrefixes = @($signatureFeed.blePrefixes).Count
    bleNamePatterns = @($signatureFeed.bleNamePatterns).Count
    bleManufacturerIds = @($signatureFeed.bleManufacturerIds).Count
    ravenServiceUuids = @($signatureFeed.ravenServiceUuids).Count
  }
  cameraSeeds = [ordered]@{
    path = "camera-seeds.json"
    version = [string]$cameraSeedFeed.version
    bytes = $cameraSeedItem.Length
    sha256 = $cameraSeedHash
    points = [int]$cameraSeedFeed.pointCount
    sources = @($cameraSeedFeed.sources).Count
  }
}

$json = $meta | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $DocsDir "site-meta.json"), $json + "`n", [System.Text.UTF8Encoding]::new($false))

"GitHub Pages staged:"
"  $DocsDir"
"  APK: $ApkReleaseUrl"
"  Firmware manifest: flasher/manifest.json"
