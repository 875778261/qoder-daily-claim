param(
  [string]$TaskName = 'QoderAutoCheckin',
  [string]$At = '10:05',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  & schtasks.exe /delete /tn $TaskName /f
  exit $LASTEXITCODE
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'claim.js'
if (-not (Test-Path -LiteralPath $script)) {
  throw "claim.js not found next to this script: $script"
}

$action = '"' + $node + '" "' + $script + '"'
& schtasks.exe /create /tn $TaskName /tr $action /sc DAILY /st $At /f
if ($LASTEXITCODE -ne 0) {
  throw "schtasks failed with exit code $LASTEXITCODE. Try running PowerShell as the current user, not elevated."
}

try {
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
  Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null
} catch {
  Write-Warning "Task created, but advanced settings could not be applied: $($_.Exception.Message)"
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-List
Write-Host "Installed: $TaskName, daily at $At, runs as the current Windows user."
Write-Host "Run now:   schtasks /run /tn $TaskName"
Write-Host "Logs:      $env:LOCALAPPDATA\qoder-auto-checkin\logs"
