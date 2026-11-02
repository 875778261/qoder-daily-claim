[CmdletBinding()]
param(
  [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
  $OutputDir = Join-Path $Root 'dist'
}

$skillName = 'qoder-daily-claim'
$source = Join-Path $Root "skill\$skillName"
if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
  throw "未找到 skill 源目录：$source"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("qoder-package-" + [guid]::NewGuid().ToString('N'))
try {
  $stage = Join-Path $stageRoot $skillName
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $stage -Recurse -Force

  $license = Join-Path $Root 'LICENSE'
  if (Test-Path -LiteralPath $license) {
    Copy-Item -LiteralPath $license -Destination (Join-Path $stage 'LICENSE') -Force
  }

  $zip = Join-Path $OutputDir "$skillName.zip"
  $skillArchive = Join-Path $OutputDir "$skillName.skill"

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [IO.File]::Open($zip, [IO.FileMode]::Create)
  try {
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      $prefixLength = $stageRoot.TrimEnd('\', '/').Length + 1
      Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
        $entryName = $_.FullName.Substring($prefixLength).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $archive, $_.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $stream.Dispose()
  }

  Copy-Item -LiteralPath $zip -Destination $skillArchive -Force

  Write-Host "已生成："
  foreach ($file in @($zip, $skillArchive)) {
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("  {0}  {1}" -f $hash, $file)
  }
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
