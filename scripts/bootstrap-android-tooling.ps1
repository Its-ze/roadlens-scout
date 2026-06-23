param(
  [string]$AndroidPlatform = "android-36",
  [string]$BuildTools = "36.0.0",
  [string]$JdkMajor = "21",
  [string]$ToolingDir = (Join-Path $env:LOCALAPPDATA "RoadLensScoutTooling")
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$JdkDir = Join-Path $ToolingDir "jdk$JdkMajor"
$SdkRoot = Join-Path $ToolingDir "android-sdk"
$DownloadsDir = Join-Path $ToolingDir "downloads"

New-Item -ItemType Directory -Force -Path $JdkDir, $SdkRoot, $DownloadsDir | Out-Null

function Test-ZipFile($Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    $zip.Dispose()
    return $true
  } catch {
    return $false
  }
}

$jdkZip = Join-Path $DownloadsDir "temurin-jdk$JdkMajor.zip"
if (-not (Test-Path -LiteralPath $jdkZip)) {
  Invoke-WebRequest `
    -Uri "https://api.adoptium.net/v3/binary/latest/$JdkMajor/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk" `
    -OutFile $jdkZip
}

if (-not (Get-ChildItem -LiteralPath $JdkDir -Directory -ErrorAction SilentlyContinue)) {
  Expand-Archive -LiteralPath $jdkZip -DestinationPath $JdkDir -Force
}

$jdkHome = Get-ChildItem -LiteralPath $JdkDir -Directory | Select-Object -First 1 -ExpandProperty FullName

$studioPage = (Invoke-WebRequest -Uri "https://developer.android.com/studio" -UseBasicParsing).Content
$cmdlineUrl = ([regex]::Matches($studioPage, 'https://dl\.google\.com/android/repository/commandlinetools-win-[0-9]+_latest\.zip') |
  Select-Object -First 1 -ExpandProperty Value)
if (-not $cmdlineUrl) {
  throw "Could not discover Android command-line tools download URL."
}

$cmdlineZip = Join-Path $DownloadsDir "commandlinetools-win-latest.zip"
if ((Test-Path -LiteralPath $cmdlineZip) -and -not (Test-ZipFile $cmdlineZip)) {
  Remove-Item -LiteralPath $cmdlineZip -Force
}

if (-not (Test-Path -LiteralPath $cmdlineZip)) {
  Invoke-WebRequest -Uri $cmdlineUrl -OutFile $cmdlineZip
}

$cmdlineRoot = Join-Path $SdkRoot "cmdline-tools"
$cmdlineLatest = Join-Path $cmdlineRoot "latest"
if (-not (Test-Path -LiteralPath $cmdlineLatest)) {
  $tmp = Join-Path $ToolingDir "cmdline-tools-expanded"
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  if (Get-Command "tar.exe" -ErrorAction SilentlyContinue) {
    & tar.exe -xf $cmdlineZip -C $tmp
  } else {
    Expand-Archive -LiteralPath $cmdlineZip -DestinationPath $tmp -Force
  }
  New-Item -ItemType Directory -Force -Path $cmdlineRoot | Out-Null

  $sourceCandidates = @(
    (Join-Path $tmp "cmdline-tools"),
    (Join-Path $tmp "tools")
  )
  $sourceDir = $sourceCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if (-not $sourceDir) {
    $sourceDir = Get-ChildItem -LiteralPath $tmp -Directory -Recurse |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "bin\sdkmanager.bat") } |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $sourceDir) {
    throw "Could not locate sdkmanager.bat in command-line tools archive."
  }

  New-Item -ItemType Directory -Force -Path $cmdlineLatest | Out-Null
  Copy-Item -Path (Join-Path $sourceDir "*") -Destination $cmdlineLatest -Recurse -Force
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:Path = "$jdkHome\bin;$SdkRoot\platform-tools;$cmdlineLatest\bin;$env:Path"

$sdkManager = Join-Path $cmdlineLatest "bin\sdkmanager.bat"
1..100 | ForEach-Object { "y" } | & $sdkManager --sdk_root=$SdkRoot --licenses
& $sdkManager --sdk_root=$SdkRoot "platform-tools" "platforms;$AndroidPlatform" "build-tools;$BuildTools"

@"
Android tooling installed for this project.

For this shell:
  `$env:JAVA_HOME = "$jdkHome"
  `$env:ANDROID_HOME = "$SdkRoot"
  `$env:ANDROID_SDK_ROOT = "$SdkRoot"
  `$env:Path = "$jdkHome\bin;$SdkRoot\platform-tools;$cmdlineLatest\bin;`$env:Path"

Then run:
  .\scripts\build-apk.ps1
"@
