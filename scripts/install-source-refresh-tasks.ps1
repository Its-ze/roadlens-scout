param(
  [switch]$PassThru
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-source-refresh.ps1"
if (-not (Test-Path -LiteralPath $runner)) {
  throw "Missing refresh runner: $runner"
}

$powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $powerShell)) {
  throw "Stable Windows PowerShell executable was not found: $powerShell"
}
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$tasks = @(
  [ordered]@{
    Name = "ITSZ RoadLens Refresh Signatures"
    Feed = "signatures"
    Trigger = New-ScheduledTaskTrigger -Daily -At "06:18"
    Description = "Refresh RoadLens signatures locally and push the guarded commit to canonical Forgejo."
  },
  [ordered]@{
    Name = "ITSZ RoadLens Refresh Camera Seeds"
    Feed = "camera-seeds"
    Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Tuesday -At "07:38"
    Description = "Refresh RoadLens camera seeds locally and push the guarded commit to canonical Forgejo."
  }
)

foreach ($task in $tasks) {
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -Feed $($task.Feed)"
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
  Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger $task.Trigger -Principal $principal -Settings $settings -Description $task.Description -Force | Out-Null
}

Write-Output "Installed guarded RoadLens source-refresh tasks for $userId."
if ($PassThru) {
  foreach ($task in $tasks) {
    Get-ScheduledTask -TaskName $task.Name | Select-Object TaskName, State, Description
  }
}
