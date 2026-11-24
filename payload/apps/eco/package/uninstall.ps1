<#
.SYNOPSIS
  AIWorkKit Eco 一键卸载（移除插件注册与 rule，保留可回滚备份）。

.PARAMETER Purge
  同时删除安装目录（%USERPROFILE%\.codebuddy\plugins\marketplaces\eco-market）。
#>
param([switch]$Purge)

$ErrorActionPreference = 'Stop'
$home_ = $env:USERPROFILE
$cbDir = Join-Path $home_ '.codebuddy'
$pluginsDir = Join-Path $cbDir 'plugins'
$marketDir = Join-Path $pluginsDir 'marketplaces\eco-market'
$target = Join-Path $marketDir 'plugins\eco'
$settingsFile = Join-Path $cbDir 'settings.json'
$knownFile = Join-Path $pluginsDir 'known_marketplaces.json'
$installedFile = Join-Path $pluginsDir 'installed_plugins.json'
$ruleFile = Join-Path $cbDir 'rules\eco-first.mdc'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$key = 'eco@eco-market'

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
  [System.IO.File]::WriteAllText($path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Backup-File($path) {
  if (Test-Path $path) {
    $bak = $path + '.bak_eco_' + $stamp
    Copy-Item -LiteralPath $path -Destination $bak -Force
    Write-Host ('  备份 ' + (Split-Path -Leaf $path))
  }
}

Write-Host 'AIWorkKit Eco 卸载' -ForegroundColor Yellow

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path (Join-Path $target 'cli\eco.js'))) {
  try { & $node.Source (Join-Path $target 'cli\eco.js') 'stop' | Out-Null } catch { }
  Write-Host '  守护进程已停止'
}

if (Test-Path $settingsFile) {
  Backup-File $settingsFile
  $settings = Read-Json $settingsFile ([pscustomobject]@{})
  if ($settings.enabledPlugins -and $settings.enabledPlugins.PSObject.Properties[$key]) {
    $settings.enabledPlugins.PSObject.Properties.Remove($key)
    Write-Json $settingsFile $settings
    Write-Host ('  已移除 ' + $key)
  }
}

if (Test-Path $installedFile) {
  Backup-File $installedFile
  $installed = Read-Json $installedFile $null
  if ($installed -and $installed.plugins -and $installed.plugins.PSObject.Properties[$key]) {
    $installed.plugins.PSObject.Properties.Remove($key)
    Write-Json $installedFile $installed
    Write-Host '  已更新 installed_plugins.json'
  }
}

if (Test-Path $knownFile) {
  Backup-File $knownFile
  $known = Read-Json $knownFile $null
  if ($known -and $known.PSObject.Properties['eco-market']) {
    $known.PSObject.Properties.Remove('eco-market')
    Write-Json $knownFile $known
    Write-Host '  已更新 known_marketplaces.json'
  }
}

if (Test-Path $ruleFile) {
  Backup-File $ruleFile
  Remove-Item -LiteralPath $ruleFile -Force
  Write-Host '  已删除 rule: eco-first.mdc'
}

if ($Purge -and (Test-Path $marketDir)) {
  Remove-Item -LiteralPath $marketDir -Recurse -Force
  Write-Host ('  已删除 ' + $marketDir)
}

Write-Host ''
Write-Host '卸载完成（备份文件保留，可手动回滚）。' -ForegroundColor Green
Write-Host 'AIWorkKit 中重载窗口后彻底生效：Ctrl+Shift+P -> Developer: Reload Window'
