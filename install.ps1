[CmdletBinding()]
param(
  [bool]$InstallTask = $true,
  [string]$TaskName = 'QoderAutoCheckin',
  [string]$At = '10:05',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$Repo = '875778261/qoder-auto-checkin'
$Branch = 'main'
$SkillName = 'qoder-daily-claim'
$Target = Join-Path $env:USERPROFILE ".qoder-cn\skills\$SkillName"

function Remove-TaskIfExists {
  param([string]$Name)
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  }
}

if ($Uninstall) {
  Remove-TaskIfExists -Name $TaskName
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
  }
  Write-Host "已删除 skill：$Target"
  Write-Host "已删除计划任务：$TaskName（若存在）"
  return
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  throw '未找到 Node.js。请先安装 Node.js 18+：https://nodejs.org/'
}
$nodeVersion = (& $node.Source --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 18) {
  throw "Node.js 版本过低（$nodeVersion），需要 18 或更高版本。"
}

$tempRoot = $null
try {
  $source = if ($PSScriptRoot) { Join-Path $PSScriptRoot "skills\$SkillName" } else { $null }
  if (-not $source -or -not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("qoder-skill-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $zip = Join-Path $tempRoot 'repo.zip'
    $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
    Write-Host "下载 skill：$url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $tempRoot -Force
    $source = Join-Path $tempRoot "qoder-auto-checkin-$Branch\skills\$SkillName"
  }

  if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
    throw "未找到 skill 源目录：$source"
  }

  $skillsDir = Split-Path -Parent $Target
  New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Get-ChildItem -LiteralPath $source -Force |
    Where-Object { $_.Name -ne 'checkin-logs' } |
    Copy-Item -Destination $Target -Recurse -Force

  if (-not (Test-Path -LiteralPath (Join-Path $Target 'SKILL.md'))) {
    throw "安装失败：$Target 中缺少 SKILL.md"
  }

  Write-Host "已安装 skill：$Target"

  if ($InstallTask) {
    & (Join-Path $Target 'scripts\install-task.ps1') -TaskName $TaskName -At $At
  } else {
    Write-Host "已跳过计划任务安装。"
  }

  Write-Host ''
  Write-Host "试运行：node `"$(Join-Path $Target 'scripts\claim.js')`" --dry-run"
  if ($InstallTask) {
    Write-Host "计划任务：$TaskName，每天 $At"
  }
  Write-Host "卸载：重新下载本脚本后运行 -Uninstall"
} finally {
  if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
