param(
  [Parameter(Mandatory = $true)]
  [string]$Port,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$python = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
  throw "PlatformIO Python was not found: $python"
}

$blockSize = 0x10000
$blockCount = 64
$safePort = $Port -replace '[^A-Za-z0-9_-]', '_'
$blockRoot = Join-Path $env:TEMP "roadlens-rom-backup-$safePort"
New-Item -ItemType Directory -Path $blockRoot -Force | Out-Null

$blocks = @()
for ($index = 0; $index -lt $blockCount; $index++) {
  $offset = $index * $blockSize
  $block = Join-Path $blockRoot ("block-{0:D2}.bin" -f $index)
  $blocks += $block

  $existing = Get-Item -LiteralPath $block -ErrorAction SilentlyContinue
  if ($existing -and $existing.Length -eq $blockSize) {
    continue
  }

  $completed = $false
  for ($attempt = 1; $attempt -le 3 -and -not $completed; $attempt++) {
    Write-Output ("{0} block {1}/{2} attempt {3}" -f $Port, ($index + 1), $blockCount, $attempt)
    & $python -m esptool --chip esp32 --port $Port --baud 115200 --no-stub read_flash $offset $blockSize $block
    $result = Get-Item -LiteralPath $block -ErrorAction SilentlyContinue
    $completed = $LASTEXITCODE -eq 0 -and $result -and $result.Length -eq $blockSize
  }

  if (-not $completed) {
    throw "$Port failed to read flash block $index after three attempts"
  }
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  foreach ($block in $blocks) {
    $input = [System.IO.File]::OpenRead($block)
    try {
      $input.CopyTo($output)
    } finally {
      $input.Dispose()
    }
  }
} finally {
  $output.Dispose()
}

$backup = Get-Item -LiteralPath $OutputPath
if ($backup.Length -ne 0x400000) {
  throw "$Port backup size mismatch: $($backup.Length)"
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath
Write-Output ("{0} backup complete: {1} bytes SHA256 {2}" -f $Port, $backup.Length, $hash.Hash)
