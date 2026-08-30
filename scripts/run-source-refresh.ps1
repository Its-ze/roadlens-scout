param(
  [Parameter(Mandatory)]
  [ValidateSet("signatures", "camera-seeds")]
  [string]$Feed
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Mutex = [System.Threading.Mutex]::new($false, "Local\ITSZ-RoadLens-Source-Refresh")
$hasLock = $false

try {
  $hasLock = $Mutex.WaitOne(0)
  if (-not $hasLock) {
    throw "Another RoadLens source refresh is already running."
  }

  $initialStatus = @(git -C $Root status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read the RoadLens Git worktree." }
  if ($initialStatus.Count -gt 0) { throw "RoadLens worktree is not clean; refresh was skipped." }

  $branch = (git -C $Root branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") { throw "RoadLens must be on the main branch." }

  git -C $Root fetch --quiet origin main
  if ($LASTEXITCODE -ne 0) { throw "Unable to fetch canonical Forgejo origin/main." }
  $head = (git -C $Root rev-parse HEAD).Trim()
  $originHead = (git -C $Root rev-parse origin/main).Trim()
  if ($head -ne $originHead) { throw "Local main does not exactly match Forgejo origin/main; refresh was skipped." }

  if ($Feed -eq "signatures") {
    $allowedPaths = @("data/signatures.json", "app/public/signatures.json")
    & (Join-Path $PSScriptRoot "update-signatures.ps1")
    $commitMessage = "Update RoadLens detection signatures"
  } else {
    $allowedPaths = @(
      "data/camera-seeds.json",
      "app/public/camera-seeds.json",
      "docs/camera-seeds.json",
      "docs/site-meta.json",
      "docs/downloads/checksums.txt"
    )
    & (Join-Path $PSScriptRoot "update-camera-seeds.ps1")
    $commitMessage = "Update RoadLens camera seed map"
  }
  if ($LASTEXITCODE -ne 0) { throw "RoadLens $Feed updater failed." }

  & (Join-Path $PSScriptRoot "verify-source-feeds.ps1") -Feed $Feed
  if ($LASTEXITCODE -ne 0) { throw "RoadLens $Feed verification failed." }

  $changedPaths = @(
    git -C $Root diff --name-only
    git -C $Root ls-files --others --exclude-standard
  ) | Where-Object { $_ } | Sort-Object -Unique
  $unexpected = @($changedPaths | Where-Object { $_ -notin $allowedPaths })
  if ($unexpected.Count -gt 0) {
    throw "Updater changed files outside its allowlist: $($unexpected -join ', ')"
  }

  if ($changedPaths.Count -eq 0) {
    Write-Output "No $Feed changes were produced."
    exit 0
  }

  git -C $Root add -- $allowedPaths
  if ($LASTEXITCODE -ne 0) { throw "Unable to stage RoadLens $Feed outputs." }
  git -C $Root -c user.name="ITSZ Local Automation" -c user.email="automation@itsz.studio" commit -m $commitMessage
  if ($LASTEXITCODE -ne 0) { throw "Unable to commit RoadLens $Feed outputs." }
  git -C $Root push origin HEAD:main
  if ($LASTEXITCODE -ne 0) { throw "Unable to push RoadLens $Feed update to Forgejo origin/main." }

  git -C $Root fetch --quiet origin main
  if ($LASTEXITCODE -ne 0) { throw "Unable to verify Forgejo after the push." }
  $pushedHead = (git -C $Root rev-parse HEAD).Trim()
  $verifiedOriginHead = (git -C $Root rev-parse origin/main).Trim()
  if ($pushedHead -ne $verifiedOriginHead) { throw "Forgejo origin/main did not confirm the new commit." }

  Write-Output "RoadLens $Feed refresh committed and verified on Forgejo: $pushedHead"
} catch {
  Write-Error $_
  exit 1
} finally {
  if ($hasLock) { [void]$Mutex.ReleaseMutex() }
  $Mutex.Dispose()
}
