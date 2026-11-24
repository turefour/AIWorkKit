<#
.SYNOPSIS
  AIWorkKit 空闲降温器 - 卸载。

.DESCRIPTION
  先恢复所有被挂起的进程，再清除插件注册、开机启动项与插件目录。
  所有被修改的 json 文件都会先备份为 *.bak_tuner_<时间戳>。

.PARAMETER Purge
  连同运行数据（%LOCALAPPDATA%\AIWorkKitIdleTuner，含日志与状态）一起删除。

.PARAMETER DryRun
  只打印将执行的动作。
#>
param(
  [switch]$Purge,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$cbDir         = Join-Path $env:USERPROFILE '.codebuddy'
$pluginsDir    = Join-Path $cbDir 'plugins'
$marketDir     = Join-Path $pluginsDir 'marketplaces\tuner-market'
$target        = Join-Path $marketDir 'plugins\tuner'
$settingsFile  = Join-Path $cbDir 'settings.json'
$knownFile     = Join-Path $pluginsDir 'known_marketplaces.json'
$installedFile = Join-Path $pluginsDir 'installed_plugins.json'
$dataDir       = Join-Path $env:LOCALAPPDATA 'AIWorkKitIdleTuner'
$startupLnk    = Join-Path ([Environment]::GetFolderPath('Startup')) 'AIWorkKit Idle Tuner Tray.lnk'
$stamp         = Get-Date -Format 'yyyyMMddHHmmss'
$key           = 'tuner@tuner-market'

function Write-Section($text) {
  Write-Host ''
  Write-Host ('== ' + $text) -ForegroundColor Cyan
}

function Read-Json($path, $fallback) {
  if (-not (Test-Path $path)) { return $fallback }
  try {
    $raw = [System.IO.File]::ReadAllText($path)
    if (-not $raw.Trim()) { return $fallback }
    return ($raw | ConvertFrom-Json)
  } catch { return $fallback }
}

function Write-Json($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 12
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $json + "`n", $utf8)
}

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  Copy-Item -LiteralPath $path -Destination ($path + '.bak_tuner_' + $stamp) -Force
}

Write-Host 'AIWorkKit 空闲降温器 - 卸载' -ForegroundColor Green
Write-Host ('  插件目录 : ' + $target)

if ($DryRun) {
  Write-Section 'DRY RUN'
  Write-Host '  1. 停止托盘进程'
  Write-Host '  2. 恢复被挂起的进程并还原优先级'
  Write-Host '  3. 清除插件注册（known / installed / settings）'
  Write-Host '  4. 删除开机启动快捷方式'
  Write-Host ('  5. 删除插件目录 ' + $target)
  if ($Purge) { Write-Host ('  6. 删除运行数据 ' + $dataDir) }
  Write-Host ''
  Write-Host '未修改任何文件。' -ForegroundColor Yellow
  exit 0
}

Write-Section '1/4 停止托盘'
$trayProcs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*tuner*tray.ps1*' })
foreach ($p in $trayProcs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host ('  已停止 PID ' + $p.ProcessId)
}
if ($trayProcs.Count -eq 0) { Write-Host '  托盘未在运行' }

Write-Section '2/4 恢复占用'
$coreScript = Join-Path $target 'core\tuner.ps1'
if (Test-Path $coreScript) {
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $coreScript -Action restore -Json | Out-Null
    Write-Host '  已唤醒挂起进程并还原优先级'
  } catch {
    Write-Host ('  ! 恢复失败：' + $_.Exception.Message) -ForegroundColor Yellow
  }
} else {
  Write-Host '  插件目录不存在，跳过'
}

Write-Section '3/4 清除注册'
if (Test-Path $knownFile) {
  Backup-File $knownFile
  $known = Read-Json $knownFile ([pscustomobject]@{})
  if ($known.PSObject.Properties['tuner-market']) {
    $known.PSObject.Properties.Remove('tuner-market')
    Write-Json $knownFile $known
    Write-Host '  known_marketplaces.json 已移除 tuner-market'
  }
}

if (Test-Path $installedFile) {
  Backup-File $installedFile
  $installed = Read-Json $installedFile ([pscustomobject]@{})
  if ($installed.plugins -and $installed.plugins.PSObject.Properties[$key]) {
    $installed.plugins.PSObject.Properties.Remove($key)
    Write-Json $installedFile $installed
    Write-Host '  installed_plugins.json 已移除插件'
  }
}

if (Test-Path $settingsFile) {
  Backup-File $settingsFile
  $settings = Read-Json $settingsFile ([pscustomobject]@{})
  if ($settings.enabledPlugins -and $settings.enabledPlugins.PSObject.Properties[$key]) {
    $settings.enabledPlugins.PSObject.Properties.Remove($key)
    Write-Json $settingsFile $settings
    Write-Host '  settings.json 已关闭插件'
  }
}

Write-Section '4/4 清理文件'
if (Test-Path $startupLnk) {
  Remove-Item -LiteralPath $startupLnk -Force
  Write-Host '  已删除开机启动快捷方式'
}

if (Test-Path $marketDir) {
  Remove-Item -LiteralPath $marketDir -Recurse -Force
  Write-Host ('  已删除 ' + $marketDir)
}

if ($Purge -and (Test-Path $dataDir)) {
  Remove-Item -LiteralPath $dataDir -Recurse -Force
  Write-Host ('  已删除运行数据 ' + $dataDir)
}

Write-Host ''
Write-Host '卸载完成。重载 AIWorkKit 窗口后命令与 Hook 失效。' -ForegroundColor Green
