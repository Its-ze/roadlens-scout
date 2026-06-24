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

function Invoke-Checked($Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

Assert-Command "node" "Install Node.js or add it to PATH."
Assert-Command "npm" "Install npm or add it to PATH."
Assert-Command "java" "Install JDK 17+ or run scripts\bootstrap-android-tooling.ps1, then open a new shell."

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  throw "ANDROID_HOME or ANDROID_SDK_ROOT is not set. Install Android SDK or run scripts\bootstrap-android-tooling.ps1."
}

& (Join-Path $PSScriptRoot "sync-app-firmware.ps1")

Push-Location $AppDir
try {
  if (-not (Test-Path -LiteralPath "node_modules")) {
    Invoke-Checked "npm" @("install")
  }

  $distDir = Join-Path $AppDir "dist"
  $resolvedAppDir = [System.IO.Path]::GetFullPath($AppDir)
  $resolvedDistDir = [System.IO.Path]::GetFullPath($distDir)
  if (-not $resolvedDistDir.StartsWith($resolvedAppDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean unexpected dist path: $resolvedDistDir"
  }
  Remove-Item -LiteralPath $distDir -Recurse -Force -ErrorAction SilentlyContinue

  Invoke-Checked "npm" @("run", "build")

  if (-not (Test-Path -LiteralPath "android")) {
    Invoke-Checked "npx" @("cap", "add", "android")
  }

  Invoke-Checked "npx" @("cap", "sync", "android")

  Push-Location "android"
  try {
    if ($Release) {
      Invoke-Checked ".\gradlew.bat" @("--no-daemon", "assembleRelease")
    } else {
      Invoke-Checked ".\gradlew.bat" @("--no-daemon", "assembleDebug")
    }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
