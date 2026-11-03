param(
  [string]$TaskName = 'QoderAutoCheckin',
  [string]$At = '10:05',
  [switch]$NoWindow,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$runner = Join-Path $env:LOCALAPPDATA 'qoder-daily-claim\run-visible.ps1'
$legacyRunner = Join-Path $env:LOCALAPPDATA 'qoder-daily-claim\run-visible.cmd'

if ($Remove) {
  & schtasks.exe /delete /tn $TaskName /f
  $code = $LASTEXITCODE
  foreach ($file in @($runner, $legacyRunner)) {
    if (Test-Path -LiteralPath $file) {
      Remove-Item -LiteralPath $file -Force
    }
  }
  exit $code
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'claim.js'
if (-not (Test-Path -LiteralPath $script)) {
  throw "claim.js not found next to this script: $script"
}

if (-not $NoWindow) {
  # .cmd 由 cmd 按控制台代码页解析，混入中文容易拆错行；
  # 用 PowerShell 包装（UTF-8 BOM）既能安全显示中文，也能读取单个按键。
  $runnerDir = Split-Path -Parent $runner
  New-Item -ItemType Directory -Force -Path $runnerDir | Out-Null
  $nodeQuoted = $node.Replace("'", "''")
  $scriptQuoted = $script.Replace("'", "''")
  $invoke = "& '$nodeQuoted' '$scriptQuoted' @args"
  $lines = @(
    '$Host.UI.RawUI.WindowTitle = ''Qoder 每日领取''',
    'try {',
    "  $invoke",
    '  $code = $LASTEXITCODE',
    '} catch {',
    '  Write-Host "无法启动 node：$($_.Exception.Message)"',
    '  $code = 1',
    '}',
    'Write-Host',
    'Write-Host ''按 ESC 关闭窗口。''',
    'while ($true) {',
    '  $key = $Host.UI.RawUI.ReadKey(''NoEcho,IncludeKeyDown'')',
    '  if ($key.VirtualKeyCode -eq 27) { exit $code }',
    '}'
  )
  $content = ($lines -join "`r`n") + "`r`n"
  [IO.File]::WriteAllText($runner, $content, (New-Object System.Text.UTF8Encoding($true)))
  if (Test-Path -LiteralPath $legacyRunner) {
    Remove-Item -LiteralPath $legacyRunner -Force
  }
  $taskAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c start "Qoder 每日领取" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"')
} else {
  foreach ($file in @($runner, $legacyRunner)) {
    if (Test-Path -LiteralPath $file) {
      Remove-Item -LiteralPath $file -Force
    }
  }
  $taskAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"')
}

$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

try {
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Force | Out-Null
} catch {
  throw "创建计划任务失败：$($_.Exception.Message)。请用当前用户运行，不要用管理员身份。"
}

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-List
Write-Host "Installed: $TaskName, daily at $At, runs as the current Windows user."
if (-not $NoWindow) {
  Write-Host "Window:    stays open after the run; press ESC to close (-NoWindow to disable)."
} else {
  Write-Host "Window:    hidden (no console window kept open)."
}
Write-Host "Run now:   schtasks /run /tn $TaskName"
Write-Host "Logs:      $env:LOCALAPPDATA\qoder-daily-claim\logs"
