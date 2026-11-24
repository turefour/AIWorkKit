<#
.SYNOPSIS
  构建可直接拷到其他机器安装的便携包（内置 Node 运行时，零外部依赖）。

.DESCRIPTION
  产物目录 dist\tuner-portable\
    tuner\      插件本体
    runtime\node.exe           便携 Node 运行时（默认内置）
    install.cmd / install.ps1  一键安装
    uninstall.cmd / .ps1       一键卸载
    README-安装说明.txt        目标机器上的操作步骤
    VERSION.txt                构建信息

  目标机器只需要 Windows 10/11（自带 PowerShell 5.1 与 Edge），
  不需要预装 Node.js。

.PARAMETER OutDir
  输出目录，默认仓库下的 dist。

.PARAMETER Version
  版本号，默认取 package.json 的 version。

.PARAMETER NoNode
  不内置 node.exe（目标机器需自带 Node 18+）。

.PARAMETER NoZip
  只生成文件夹，不压缩 zip。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File package\build.ps1
#>
param(
  [string]$OutDir = '',
  [string]$Version = '',
  [switch]$NoNode,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$name = 'tuner-portable'
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'dist' }

$pkgJson = Get-Content (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = $pkgJson.version }

$stage = Join-Path $OutDir $name
$pluginDir = Join-Path $stage 'tuner'

function Write-Section($text) {
  Write-Host ''
  Write-Host ('== ' + $text) -ForegroundColor Cyan
}

Write-Host 'AIWorkKit 空闲降温器 - 构建便携包' -ForegroundColor Green
Write-Host ('  版本   : ' + $Version)
Write-Host ('  输出   : ' + $stage)

Write-Section '1/5 清理输出目录'
if (Test-Path $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
  Write-Host '  已清理旧产物'
}
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null

Write-Section '2/5 复制插件本体'
$dirs = @('cli', 'core', 'commands', 'hooks', 'tray', 'server', 'web', '.codebuddy-plugin')
foreach ($d in $dirs) {
  $from = Join-Path $repoRoot $d
  if (-not (Test-Path $from)) { throw ('插件目录缺失: ' + $from) }
  Copy-Item -LiteralPath $from -Destination (Join-Path $pluginDir $d) -Recurse -Force
}
foreach ($f in @('package.json', 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $f) -Destination (Join-Path $pluginDir $f) -Force
}
# Strip development leftovers that may exist inside the source tree.
Get-ChildItem -Path $pluginDir -Recurse -Force -Include '*.bak*', '*.log', 'node_modules' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('  已复制: ' + ($dirs -join ', '))

Write-Section '3/5 复制安装器与说明'
foreach ($f in @('install.ps1', 'install.cmd', 'uninstall.ps1', 'uninstall.cmd', 'README-安装说明.txt')) {
  $from = Join-Path $PSScriptRoot $f
  if (Test-Path $from) {
    Copy-Item -LiteralPath $from -Destination (Join-Path $stage $f) -Force
    Write-Host ('  ' + $f)
  } else {
    Write-Host ('  ! 缺少 ' + $f) -ForegroundColor Yellow
  }
}

Write-Section '4/5 内置 Node 运行时'
$runtimeInfo = 'not bundled (target machine needs Node.js 18+)'
if (-not $NoNode) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw '未找到 node，无法内置运行时（可用 -NoNode 跳过）' }

  # Pin the runtime: record exact version + SHA256 so two builds are never
  # silently different and a shipped package can be verified.
  $nodeVersion = (& $nodeCmd.Source -v).Trim()
  $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 18) { throw ('内置运行时需 Node 18+，当前 ' + $nodeVersion) }

  $runtimeDir = Join-Path $stage 'runtime'
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  $nodeCopy = Join-Path $runtimeDir 'node.exe'
  Copy-Item -LiteralPath $nodeCmd.Source -Destination $nodeCopy -Force

  $nodeHash = (Get-FileHash -LiteralPath $nodeCopy -Algorithm SHA256).Hash.ToLower()
  $runtimeInfo = ('node ' + $nodeVersion + ' sha256=' + $nodeHash)
  Write-Host ('  已内置 node.exe (' + [math]::Round((Get-Item $nodeCopy).Length / 1MB, 1) + ' MB, ' + $nodeVersion + ')')
  Write-Host ('  sha256 ' + $nodeHash)
} else {
  Write-Host '  已跳过（-NoNode）'
}

Write-Section '5/5 版本信息与压缩'
$versionText = @(
  ('name    : ' + $name),
  ('version : ' + $Version),
  ('built   : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
  ('runtime : ' + $runtimeInfo),
  ('source  : local build (path intentionally omitted)'),
  ('target  : Windows 10/11 x64, PowerShell 5.1, Edge/Chrome'),
  ''
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'VERSION.txt'), $versionText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '  VERSION.txt 已写入'

$zipPath = ''
if (-not $NoZip) {
  $zipPath = Join-Path $OutDir ($name + '-' + $Version + '.zip')
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  Write-Host ('  已压缩: ' + $zipPath + ' (' + [math]::Round((Get-Item $zipPath).Length / 1MB, 1) + ' MB)')
}

Write-Host ''
$size = (Get-ChildItem $stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ('构建完成：' + $stage + '  (' + [math]::Round($size / 1MB, 1) + ' MB)') -ForegroundColor Green
if ($zipPath) { Write-Host ('分发包   ：' + $zipPath) -ForegroundColor Green }
