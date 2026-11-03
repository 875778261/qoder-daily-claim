param(
  [string]$TaskName = 'QoderAutoCheckin',
  [string]$At = '10:05',
  [switch]$NoWindow,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$runner = Join-Path $env:LOCALAPPDATA 'qoder-daily-claim\run-visible.cmd'

if ($Remove) {
  & schtasks.exe /delete /tn $TaskName /f
  if (Test-Path -LiteralPath $runner) {
    Remove-Item -LiteralPath $runner -Force
  }
  exit $LASTEXITCODE
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'claim.js'
if (-not (Test-Path -LiteralPath $script)) {
  throw "claim.js not found next to this script: $script"
}

if (-not $NoWindow) {
  # 计划任务直接运行 node 时窗口会一闪而过；这里用独立控制台窗口运行，
  # 结束后停留并显示退出码，避免用户不知道是否执行过。
  $runnerDir = Split-Path -Parent $runner
  New-Item -ItemType Directory -Force -Path $runnerDir | Out-Null
  $lines = @(
    '@echo off',
    'chcp 65001 >nul',
    'title Qoder 每日领取',
    ('"' + $node + '" "' + $script + '" %*'),
    'set "CODE=%ERRORLEVEL%"',
    'echo.',
    'echo 退出码：%CODE%（0 成功，1 接口/网络错误，2 需要重新登录 Qoder CN）',
    'echo 按任意键关闭窗口...',
    'pause >nul',
    'exit /b %CODE%'
  )
  $content = ($lines -join "`r`n") + "`r`n"
  [IO.File]::WriteAllText($runner, $content, (New-Object System.Text.UTF8Encoding($false)))
  $taskAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c start "Qoder 每日领取" "' + $runner + '"')
} else {
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
  Write-Host "Window:    stays open after the run, press any key to close (-NoWindow to disable)."
} else {
  Write-Host "Window:    hidden (no console window kept open)."
}
Write-Host "Run now:   schtasks /run /tn $TaskName"
Write-Host "Logs:      $env:LOCALAPPDATA\qoder-daily-claim\logs"
