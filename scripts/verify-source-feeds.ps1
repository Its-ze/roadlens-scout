param(
  [ValidateSet("all", "signatures", "camera-seeds")]
  [string]$Feed = "all"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Failures = [System.Collections.Generic.List[string]]::new()

function Add-Failure {
  param([string]$Message)
  $Failures.Add($Message)
}

function Get-RepoPath {
  param([string]$RelativePath)
  Join-Path $Root ($RelativePath -replace '/', '\')
}

function Get-NormalizedTextHash {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
  }
}

function Assert-SameFile {
  param(
    [string]$Expected,
    [string]$Actual
  )

  $expectedPath = Get-RepoPath $Expected
  $actualPath = Get-RepoPath $Actual
  if (-not (Test-Path -LiteralPath $expectedPath) -or -not (Test-Path -LiteralPath $actualPath)) {
    Add-Failure "Missing mirrored feed file: $Expected or $Actual"
    return
  }

  $expectedHash = Get-NormalizedTextHash $expectedPath
  $actualHash = Get-NormalizedTextHash $actualPath
  if ($expectedHash -ne $actualHash) {
    Add-Failure "Feed copies differ: $Expected and $Actual"
  }
}

function Read-Json {
  param([string]$RelativePath)
  $path = Get-RepoPath $RelativePath
  if (-not (Test-Path -LiteralPath $path)) {
    Add-Failure "Missing JSON file: $RelativePath"
    return $null
  }

  try {
    Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    Add-Failure "Invalid JSON in ${RelativePath}: $($_.Exception.Message)"
    $null
  }
}

function Test-Signatures {
  Assert-SameFile "data/signatures.json" "app/public/signatures.json"
  $signatures = Read-Json "data/signatures.json"
  if ($null -eq $signatures) { return }

  if ($signatures.schema -ne 1) { Add-Failure "Signature schema must be 1." }
  if ([string]::IsNullOrWhiteSpace([string]$signatures.version)) { Add-Failure "Signature version is missing." }
  if (@($signatures.wifiPrefixes).Count -lt 30) { Add-Failure "Signature feed has fewer than 30 Wi-Fi prefixes." }
  if (@($signatures.blePrefixes).Count -lt 30) { Add-Failure "Signature feed has fewer than 30 BLE prefixes." }
  if (@($signatures.sources).Count -lt 1) { Add-Failure "Signature feed has no source records." }
}

function Test-CameraSeeds {
  Assert-SameFile "data/camera-seeds.json" "app/public/camera-seeds.json"
  Assert-SameFile "data/camera-seeds.json" "docs/camera-seeds.json"

  $seeds = Read-Json "data/camera-seeds.json"
  $siteMeta = Read-Json "docs/site-meta.json"
  if ($null -eq $seeds -or $null -eq $siteMeta) { return }

  $pointCount = @($seeds.points).Count
  if ($seeds.schema -ne 1) { Add-Failure "Camera seed schema must be 1." }
  if ($pointCount -lt 1000) { Add-Failure "Camera seed feed has fewer than 1000 points." }
  if ([int64]$seeds.pointCount -ne $pointCount) { Add-Failure "Camera seed pointCount does not match the points array." }
  if (@($seeds.sources).Count -lt 1) { Add-Failure "Camera seed feed has no source records." }

  $docsSeedPath = Get-RepoPath "docs/camera-seeds.json"
  $seedHash = (Get-FileHash -LiteralPath $docsSeedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $seedBytes = (Get-Item -LiteralPath $docsSeedPath).Length
  $cameraMeta = $siteMeta.cameraSeeds
  if ($null -eq $cameraMeta) {
    Add-Failure "docs/site-meta.json has no cameraSeeds record."
  } else {
    if ([string]$cameraMeta.sha256 -ne $seedHash) { Add-Failure "site-meta camera seed SHA-256 is stale." }
    if ([int64]$cameraMeta.bytes -ne $seedBytes) { Add-Failure "site-meta camera seed byte count is stale." }
    if ([int64]$cameraMeta.points -ne $pointCount) { Add-Failure "site-meta camera seed point count is stale." }
    if ([string]$cameraMeta.version -ne [string]$seeds.version) { Add-Failure "site-meta camera seed version is stale." }
  }

  $checksumsPath = Get-RepoPath "docs/downloads/checksums.txt"
  if (-not (Test-Path -LiteralPath $checksumsPath)) {
    Add-Failure "Missing docs/downloads/checksums.txt."
  } else {
    $expectedLine = "$seedHash  camera-seeds.json"
    if ($expectedLine -notin @(Get-Content -LiteralPath $checksumsPath)) {
      Add-Failure "checksums.txt has a stale camera-seeds.json SHA-256."
    }
  }
}

if ($Feed -in @("all", "signatures")) { Test-Signatures }
if ($Feed -in @("all", "camera-seeds")) { Test-CameraSeeds }

if ($Failures.Count -gt 0) {
  $Failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "RoadLens source feed verification passed for: $Feed"
