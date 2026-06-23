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
$ApkName = "roadlens-scout-v$Version-debug.apk"
$DocsApk = Join-Path $DocsDownloads $ApkName

foreach ($required in @($FlasherSource, (Join-Path $FlasherSource "manifest.json"), (Join-Path $FlasherSource "firmware"), $ApkPath, $BrandMark)) {
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

Copy-Item -LiteralPath $ApkPath -Destination $DocsApk -Force

$firmwareBin = Join-Path $DocsFlasher "firmware\firmware.bin"
$firmwareHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $firmwareBin).Hash.ToLowerInvariant()
$apkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DocsApk).Hash.ToLowerInvariant()
$apkItem = Get-Item -LiteralPath $DocsApk
$firmwareItem = Get-Item -LiteralPath $firmwareBin

$checksumText = @(
  "$apkHash  downloads/$ApkName",
  "$firmwareHash  flasher/firmware/firmware.bin"
) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $DocsDownloads "checksums.txt"), $checksumText + "`n", [System.Text.UTF8Encoding]::new($false))

$meta = [ordered]@{
  name = "RoadLens Scout"
  version = $Version
  generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  apk = [ordered]@{
    path = "downloads/$ApkName"
    bytes = $apkItem.Length
    sha256 = $apkHash
  }
  firmware = [ordered]@{
    manifest = "flasher/manifest.json"
    path = "flasher/firmware/firmware.bin"
    bytes = $firmwareItem.Length
    sha256 = $firmwareHash
  }
}

$json = $meta | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $DocsDir "site-meta.json"), $json + "`n", [System.Text.UTF8Encoding]::new($false))

"GitHub Pages staged:"
"  $DocsDir"
"  APK: downloads/$ApkName"
"  Firmware manifest: flasher/manifest.json"
