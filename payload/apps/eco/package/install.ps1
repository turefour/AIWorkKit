<#
.SYNOPSIS
  AIWorkKit Eco 一键安装（注册插件市场、写入 rule、启动守护进程）。

.DESCRIPTION
  在目标设备上运行本脚本即可完成：
    1) 校验 node
    2) 把插件装入 [平台目录]\plugins\marketplaces\eco-market（默认 ~/.aiworkkit，可用 -Platform 指定）
    3) 注册 known_marketplaces / installed_plugins / settings.enabledPlugins
    4) 生成 [平台目录]/rules/eco-first.mdc（路径按本机实际位置写入）
    5) 启动守护进程
  所有被修改的 json/规则文件都会先备份为 *.bak_eco_<时间戳>。

.PARAMETER Link
  用目录联接指向包内插件目录（便于随包更新），默认复制进 -Platform 指定的平台目录。

.PARAMETER DryRun
  只打印将要执行的动作，不修改任何文件。

.PARAMETER NoStart
  安装完成后不启动守护进程。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
#>
param(
  [switch]$Link,
  [switch]$DryRun,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

# Works both in the built package (install.ps1 next to eco\) and in
# the plugin repo (package\install.ps1 with the plugin one level up).
$packageRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $packageRoot 'eco'))) {
  $packageRoot = Split-Path -Parent $PSScriptRoot
}
$source = Join-Path $packageRoot 'eco'

# 插件清单：通用名 .aiplugin 优先，历史名 .codebuddy-plugin 仍兼容。
# 市场清单（marketplace.json）沿用平台自身的目录约定，不在此处改写。
function Test-PluginManifest($dir) {
  foreach ($name in @('.aiplugin', '.codebuddy-plugin')) {
    if (Test-Path (Join-Path $dir ($name + '\plugin.json'))) { return $true }
  }
  return $false
}
$rulesTemplate = Join-Path $PSScriptRoot 'rules\eco-first.mdc.template'

$home_ = $env:USERPROFILE

# 插件装到哪个平台由 -Platform 决定，目录取自 config/platforms.json。
# 以前写死 .codebuddy，等于这套安装器只服务一个平台。
$kitRoot = $null
try { $kitRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..") -ErrorAction Stop).Path } catch { $kitRoot = $null }
$platformsFile = if ($kitRoot) { Join-Path $kitRoot "config\platforms.json" } else { "" }
$platformCfg = $null
if ($platformsFile -and (Test-Path $platformsFile)) {
  try {
    $allPlatforms = Get-Content $platformsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $platformCfg = $allPlatforms.platforms.$Platform
  } catch { $platformCfg = $null }
}
$configDirRaw = if ($platformCfg -and $platformCfg.configDir) { [string]$platformCfg.configDir } else { "~/.aiworkkit" }
if ($configDirRaw.StartsWith("~")) {
  $configDirRaw = Join-Path $home_ ($configDirRaw.Substring(1).TrimStart("\", "/"))
}
$platformDir = $configDirRaw
$pluginsDir = Join-Path $platformDir 'plugins'
$marketDir = Join-Path $pluginsDir 'marketplaces\eco-market'
$target = Join-Path $marketDir 'plugins\eco'
$settingsFile = Join-Path $platformDir 'settings.json'
$knownFile = Join-Path $pluginsDir 'known_marketplaces.json'
$installedFile = Join-Path $pluginsDir 'installed_plugins.json'
$rulesDir = Join-Path $platformDir 'rules'
$ruleFile = Join-Path $rulesDir 'eco-first.mdc'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$key = 'eco@eco-market'

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
  } catch {
    Write-Host ('  ! 无法解析 ' + $path + '，将使用空配置') -ForegroundColor Yellow
    return $fallback
  }
}

function Write-Json($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 12
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $json + "`n", $utf8)
}

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  $bak = $path + '.bak_eco_' + $stamp
  Copy-Item -LiteralPath $path -Destination $bak -Force
  Write-Host ('  备份 ' + (Split-Path -Leaf $path) + ' -> ' + (Split-Path -Leaf $bak))
}

function Ensure-Prop($obj, $name, $value) {
  $existing = $obj.PSObject.Properties[$name]
  if ($existing) { $existing.Value = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force }
}

Write-Host 'AIWorkKit Eco 一键安装' -ForegroundColor Green
Write-Host ('  包目录     : ' + $packageRoot)
Write-Host ('  安装目标   : ' + $target)
Write-Host ('  插件注册名 : ' + $key)

if (-not (Test-PluginManifest $source)) {
  Write-Host ('找不到插件本体：' + $source) -ForegroundColor Red
  Write-Host '请确认压缩包完整解压后再运行本脚本。' -ForegroundColor Red
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '未检测到 node，请先安装 Node.js 18+（https://nodejs.org）后重试。' -ForegroundColor Red
  exit 1
}
Write-Host ('  node       : ' + $node.Source)

if ($DryRun) {
  Write-Section 'DRY RUN - 将执行以下动作'
  Write-Host ('  1. 复制插件: ' + $source + ' -> ' + $target + $(if ($Link) { '（改用目录联接）' } else { '' }))
  Write-Host ('  2. 写市场清单: ' + (Join-Path $marketDir '.codebuddy-plugin\marketplace.json'))
  Write-Host ('  3. 更新注册: ' + $knownFile + ' / ' + $installedFile + ' / ' + $settingsFile)
  Write-Host ('  4. 写规则  : ' + $ruleFile + '（PLUGIN_ROOT 替换为 ' + $target + '）')
  Write-Host ($(if ($NoStart) { '  5. 不启动守护进程（-NoStart）' } else { '  5. 启动守护进程: node cli\eco.js server --daemon' }))
  Write-Host ''
  Write-Host '未修改任何文件。' -ForegroundColor Yellow
  exit 0
}

Write-Section '1/5 安装插件文件'
if (Test-Path $target) {
  if ($Link) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host '  已存在，就地覆盖（保留 .eco 运行数据）'
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $marketDir 'plugins') | Out-Null

if ($Link) {
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Junction -Path $target -Target $source | Out-Null
  Write-Host '  已创建目录联接（更新包内容即生效）'
} elseif (Test-PluginManifest $target) {
  # 只同步代码与资源，不碰运行数据
  $exclude = @('.eco', 'logs', 'node_modules')
  foreach ($item in @('cli', 'commands', 'hooks', 'server', 'skills', 'test', 'web', 'package')) {
    $from = Join-Path $source $item
    if (Test-Path $from) {
      Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
    }
  }
  foreach ($file in @('.aiplugin', 'package.json', 'README.md')) {
    $from = Join-Path $source $file
    if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination $target -Recurse -Force }
  }
  Write-Host '  已覆盖代码与资源（跳过后台数据：' + ($exclude -join ', ') + '）'
} else {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $exclude = @('.eco', 'logs', 'node_modules', '*.bak_*')
  Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force -Exclude $exclude
  Write-Host '  已复制插件'
}

Write-Section '2/5 写市场清单'
$manifest = [pscustomobject]@{
  name = 'eco-market'
  description = 'Local marketplace for eco'
  owner = [pscustomobject]@{ name = 'local' }
  plugins = @(
    [pscustomobject]@{
      name = 'eco'
      description = 'AIWorkKit 运行时监控：插件/脚本/流程进度与日志可视化'
      version = '1.0.0'
      source = './plugins/eco'
    }
  )
}
New-Item -ItemType Directory -Force -Path (Join-Path $marketDir '.aiplugin') | Out-Null
Write-Json (Join-Path $marketDir '.codebuddy-plugin\marketplace.json') $manifest
Write-Host '  市场清单已写入'

Write-Section '3/5 更新插件注册'
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

Backup-File $knownFile
$known = Read-Json $knownFile ([pscustomobject]@{})
Ensure-Prop $known 'eco-market' ([pscustomobject]@{
  manifestName = 'eco-market'
  type = 'directory'
  source = [pscustomobject]@{ source = 'directory'; path = $marketDir }
  installLocation = $marketDir
  description = 'Local marketplace for eco'
  lastUpdated = (Get-Date).ToString('o')
  autoUpdate = $false
})
Write-Json $knownFile $known
Write-Host '  known_marketplaces.json 已更新'

Backup-File $installedFile
$installed = Read-Json $installedFile ([pscustomobject]@{ version = 2; plugins = [pscustomobject]@{} })
if (-not $installed.plugins) { Ensure-Prop $installed 'plugins' ([pscustomobject]@{}) }
Ensure-Prop $installed 'version' 2
Ensure-Prop $installed.plugins $key @([pscustomobject]@{
  scope = 'user'
  installPath = $target
  contentHash = 'local'
  version = '1.0.0'
  resolvedVersion = '1.0.0'
  installedAt = (Get-Date).ToString('o')
  lastUpdated = (Get-Date).ToString('o')
})
Write-Json $installedFile $installed
Write-Host '  installed_plugins.json 已更新'

Backup-File $settingsFile
$settings = Read-Json $settingsFile ([pscustomobject]@{})
if (-not $settings.enabledPlugins) { Ensure-Prop $settings 'enabledPlugins' ([pscustomobject]@{}) }
$stale = @($settings.enabledPlugins.PSObject.Properties | Where-Object { $_.Name -like 'eco@*' -and $_.Name -ne $key })
foreach ($item in $stale) {
  $settings.enabledPlugins.PSObject.Properties.Remove($item.Name)
  Write-Host ('  移除旧注册 ' + $item.Name)
}
Ensure-Prop $settings.enabledPlugins $key $true
Write-Json $settingsFile $settings
Write-Host '  settings.json 已更新（enabledPlugins）'

Write-Section '4/5 写入 rule'
New-Item -ItemType Directory -Force -Path $rulesDir | Out-Null
if (Test-Path $rulesTemplate) {
  Backup-File $ruleFile
  $text = [System.IO.File]::ReadAllText($rulesTemplate)
  $text = $text.Replace('{{PLUGIN_ROOT}}', $target)
  $text = $text.Replace('{{PACKAGE_ROOT}}', $packageRoot)
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ruleFile, $text, $utf8)
  Write-Host ('  已写入 ' + $ruleFile)
} else {
  Write-Host '  ! 未找到规则模板，跳过' -ForegroundColor Yellow
}

Write-Section '5/5 启动守护进程'
if ($NoStart) {
  Write-Host '  已跳过（-NoStart）'
} else {
  try {
    & $node.Source (Join-Path $target 'cli\eco.js') 'server' '--daemon' | Out-Host
  } catch {
    Write-Host ('  启动失败：' + $_.Exception.Message) -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '下一步：在 AIWorkKit 中按 Ctrl+Shift+P -> Developer: Reload Window，' -ForegroundColor Yellow
Write-Host '重载后每次启动 AIWorkKit 都会自动拉起监控（SessionStart hook）。' -ForegroundColor Yellow
Write-Host ''
Write-Host ('打开独立窗口：node "' + (Join-Path $target 'cli\eco.js') + '" open')
Write-Host ('查看状态    ：node "' + (Join-Path $target 'cli\eco.js') + '" status')