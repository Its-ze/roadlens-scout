param(
  [switch]$Release
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root "app"
$ToolingCandidates = @(
  (Join-Path $env:LOCALAPPDATA "RoadLensScoutTooling"),
  (Join-Path $Root ".tooling")
)
$ToolingDir = $ToolingCandidates |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $ToolingDir) {
  $ToolingDir = Join-Path $env:LOCALAPPDATA "RoadLensScoutTooling"
}
$LocalSdk = Join-Path $ToolingDir "android-sdk"
$LocalJdkRoot = if (Test-Path -LiteralPath (Join-Path $ToolingDir "jdk21")) {
  Join-Path $ToolingDir "jdk21"
} else {
  Join-Path $ToolingDir "jdk17"
}

if (-not (Get-Command "java" -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $LocalJdkRoot)) {
  $localJdk = Get-ChildItem -LiteralPath $LocalJdkRoot -Directory -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if ($localJdk) {
    $env:JAVA_HOME = $localJdk
    $env:Path = "$localJdk\bin;$env:Path"
  }
}

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT -and (Test-Path -LiteralPath $LocalSdk)) {
  $cmdlineLatest = Join-Path $LocalSdk "cmdline-tools\latest\bin"
  $platformTools = Join-Path $LocalSdk "platform-tools"
  $env:ANDROID_HOME = $LocalSdk
  $env:ANDROID_SDK_ROOT = $LocalSdk
  $env:Path = "$platformTools;$cmdlineLatest;$env:Path"
}

function Assert-Command($Name, $InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is not available. $InstallHint"
  }
}

Assert-Command "node" "Install Node.js or add it to PATH."
Assert-Command "npm" "Install npm or add it to PATH."
Assert-Command "java" "Install JDK 17+ or run scripts\bootstrap-android-tooling.ps1, then open a new shell."

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  throw "ANDROID_HOME or ANDROID_SDK_ROOT is not set. Install Android SDK or run scripts\bootstrap-android-tooling.ps1."
}

Push-Location $AppDir
try {
  if (-not (Test-Path -LiteralPath "node_modules")) {
    npm install
  }

  npm run build

  if (-not (Test-Path -LiteralPath "android")) {
    npx cap add android
  }

  npx cap sync android

  Push-Location "android"
  try {
    if ($Release) {
      .\gradlew.bat --no-daemon assembleRelease
    } else {
      .\gradlew.bat --no-daemon assembleDebug
    }
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
