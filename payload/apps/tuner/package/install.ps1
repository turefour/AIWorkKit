<#
.SYNOPSIS
  AIWorkKit 空闲降温器 - 一键安装（注册本地插件市场 + 内置运行时 + 可选托盘自启）。

.DESCRIPTION
  1) 解析运行时：优先用包内 runtime\node.exe，其次用系统 node
  2) 把插件装到 %USERPROFILE%\.codebuddy\plugins\marketplaces\tuner-market
  3) 把 hooks.json 与 commands\*.md 里的 node 命令改写成运行时绝对路径，
     这样目标机器即使没有装 Node.js 也能跑 Hook 与命令
  4) 注册 known_marketplaces / installed_plugins / settings.enabledPlugins
  5) 可选：托盘加入开机启动并立即拉起
  所有被修改的 json 文件都会先备份为 *.bak_tuner_<时间戳>。

.PARAMETER Link
  用目录联接指向本仓库（开发用）。此刻不内置运行时、不改写命令，
  因此要求系统已安装 Node.js 18+。

.PARAMETER DryRun
  只打印将执行的动作。

.PARAMETER NoTray
  安装完成后不启动托盘。

.PARAMETER TrayAtLogin
  把托盘加入当前用户的开机启动（默认不加；插件已通过 SessionStart 随 AIWorkKit 启动）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -TrayAtLogin
#>
param(
  [switch]$Link,
  [switch]$DryRun,
  [switch]$NoTray,
  [switch]$TrayAtLogin
)

$ErrorActionPreference = 'Stop'

$packageRoot = $PSScriptRoot
$source = Join-Path $PSScriptRoot 'tuner'
if (-not (Test-Path (Join-Path $source '.codebuddy-plugin\plugin.json'))) {
  # Repo layout: <repo>\package\install.ps1 with the plugin body one level up.
  $parent = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $parent '.codebuddy-plugin\plugin.json')) {
    $packageRoot = $parent
    $source = $parent
  }
}
$bundledRuntime = Join-Path $packageRoot 'runtime\node.exe'

$cbDir         = Join-Path $env:USERPROFILE '.codebuddy'
$pluginsDir    = Join-Path $cbDir 'plugins'
$marketDir     = Join-Path $pluginsDir 'marketplaces\tuner-market'
$target        = Join-Path $marketDir 'plugins\tuner'
$settingsFile  = Join-Path $cbDir 'settings.json'
$knownFile     = Join-Path $pluginsDir 'known_marketplaces.json'
$installedFile = Join-Path $pluginsDir 'installed_plugins.json'
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
  $bak = $path + '.bak_tuner_' + $stamp
  Copy-Item -LiteralPath $path -Destination $bak -Force
  Write-Host ('  备份 ' + (Split-Path -Leaf $path) + ' -> ' + (Split-Path -Leaf $bak))
}

function Ensure-Prop($obj, $name, $value) {
  $existing = $obj.PSObject.Properties[$name]
  if ($existing) { $existing.Value = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force }
}

function Update-PluginRuntimePaths {
  param([string]$Root, [string]$NodeExe)

  $hooksFile = Join-Path $Root 'hooks\hooks.json'
  if (Test-Path $hooksFile) {
    $json = [System.IO.File]::ReadAllText($hooksFile) | ConvertFrom-Json
    $changed = 0
    foreach ($evt in $json.hooks.PSObject.Properties) {
      foreach ($group in @($evt.Value)) {
        foreach ($h in @($group.hooks)) {
          if ($h.command -match '^node\s+') {
            $h.command = ('"' + $NodeExe + '" ' + $h.command.Substring(5))
            $changed++
          } elseif ($h.command -match '^"[^"]*node\.exe"\s+') {
            $h.command = ($h.command -replace '^"[^"]*node\.exe"', ('"' + $NodeExe + '"'))
            $changed++
          }
        }
      }
    }
    if ($changed -gt 0) {
      Write-Json $hooksFile $json
      Write-Host ('  hooks.json：' + $changed + ' 条 Hook 命令改为绝对路径')
    }
  }

  $cmdDir = Join-Path $Root 'commands'
  if (Test-Path $cmdDir) {
    $files = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $cmdDir -Filter '*.md' -File)) {
      $text = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
      # 1) normalise an earlier absolute node path (re-install on another device)
      $updated = [regex]::Replace($text, '"[^"\r\n]*?node\.exe"', ('"' + $NodeExe + '"'))
      # 2) rewrite bare `node "${AIWORKKIT_PLUGIN_ROOT}...` occurrences, including
      #    inline ones inside bullet lists and fenced blocks
      $updated = $updated.Replace('node "${AIWORKKIT_PLUGIN_ROOT}', ('"' + $NodeExe + '" "${AIWORKKIT_PLUGIN_ROOT}'))
      if ($updated -ne $text) {
        [System.IO.File]::WriteAllText($f.FullName, $updated, (New-Object System.Text.UTF8Encoding($false)))
        $files++
      }
    }
    if ($files -gt 0) { Write-Host ('  commands：' + $files + ' 个命令文档改为绝对路径') }
  }
}

Write-Host 'AIWorkKit 空闲降温器 - 一键安装' -ForegroundColor Green
Write-Host ('  包目录     : ' + $packageRoot)
Write-Host ('  安装目标   : ' + $target)
Write-Host ('  插件注册名 : ' + $key)

if (-not (Test-Path (Join-Path $source '.codebuddy-plugin\plugin.json'))) {
  Write-Host ('找不到插件本体：' + $source) -ForegroundColor Red
  exit 1
}

Write-Section '0/5 解析运行时'
$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($Link) {
  if (-not $systemNode) {
    Write-Host '开发模式（-Link）需要系统已安装 Node.js 18+。' -ForegroundColor Red
    exit 1
  }
  $runtimeMode = 'system(dev-link)'
  $nodeForPlugin = $systemNode.Source
} elseif (Test-Path $bundledRuntime) {
  $runtimeMode = 'bundled'
  $nodeForPlugin = $bundledRuntime
} elseif ($systemNode) {
  $runtimeMode = 'system'
  $nodeForPlugin = $systemNode.Source
} else {
  Write-Host '未找到运行时：包内没有 runtime\node.exe，系统也没装 Node.js。' -ForegroundColor Red
  Write-Host '请使用完整便携包，或先安装 Node.js 18+。' -ForegroundColor Red
  exit 1
}
Write-Host ('  运行时     : ' + $runtimeMode + ' -> ' + $nodeForPlugin)

if ($DryRun) {
  Write-Section 'DRY RUN - 将执行以下动作'
  Write-Host ('  1. 安装插件: ' + $source + ' -> ' + $target + $(if ($Link) { '（目录联接）' } else { '' }))
  if ($runtimeMode -eq 'bundled') {
    Write-Host ('  2. 安装运行时: ' + $bundledRuntime + ' -> ' + (Join-Path $target 'runtime\node.exe'))
  }
  Write-Host ('  3. 改写 Hook/命令里的 node 路径: ' + $(if ($Link) { '跳过（开发模式）' } else { $nodeForPlugin }))
  Write-Host ('  4. 写市场清单: ' + (Join-Path $marketDir '.codebuddy-plugin\marketplace.json'))
  Write-Host ('  5. 更新注册  : ' + $knownFile + ' / ' + $installedFile + ' / ' + $settingsFile)
  Write-Host ('  6. 托盘开机自启: ' + $(if ($TrayAtLogin) { '是' } else { '否' }))
  Write-Host ('  7. 启动托盘  : ' + $(if ($NoTray) { '跳过（-NoTray）' } else { '是' }))
  Write-Host ''
  Write-Host '未修改任何文件。' -ForegroundColor Yellow
  exit 0
}

Write-Section '1/5 安装插件文件'

# An upgrade must not fight a running tray/server: node.exe is locked while the
# dashboard server runs from <target>\runtime, so stop them first (they restart
# at the end of this script).
Write-Host '  停止旧的托盘/服务进程'
try {
  # Only stop processes that belong to THIS install (or the repo it links to).
  # Matching the script name alone killed unrelated user scripts that happened to
  # be called tray.ps1 or tuner-server.js.
  $targetNeedle = '*' + $target + '*'
  $sourceNeedle = '*' + $source + '*'
  Get-CimInstance Win32_Process | Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    if (-not (($cmd -like $targetNeedle) -or ($cmd -like $sourceNeedle))) { return $false }
    ($_.Name -eq 'powershell.exe' -and $cmd -match 'tray\.ps1') -or
    ($_.Name -eq 'node.exe' -and $cmd -match 'tuner-server\.js')
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ('    已停止 ' + $_.Name + ' (' + $_.ProcessId + ')')
  }
  Start-Sleep -Milliseconds 600
} catch {
  Write-Host ('    ! 停止进程失败：' + $_.Exception.Message) -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path (Join-Path $marketDir 'plugins') | Out-Null

if ($Link) {
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Junction -Path $target -Target $source | Out-Null
  Write-Host '  已创建目录联接（改仓库即生效）'
} else {
  $dirs = @('cli', 'core', 'commands', 'hooks', 'tray', 'server', 'web', '.codebuddy-plugin')
  foreach ($d in $dirs) {
    $from = Join-Path $source $d
    if (Test-Path $from) {
      New-Item -ItemType Directory -Force -Path (Join-Path $target $d) | Out-Null
      Copy-Item -Path (Join-Path $from '*') -Destination (Join-Path $target $d) -Recurse -Force
    }
  }
  foreach ($f in @('package.json', 'README.md')) {
    $from = Join-Path $source $f
    if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination $target -Force }
  }
  Write-Host ('  插件文件已复制: ' + ($dirs -join ', '))
}

Write-Section '2/5 安装运行时'
if ($runtimeMode -eq 'bundled') {
  $targetRuntimeDir = Join-Path $target 'runtime'
  New-Item -ItemType Directory -Force -Path $targetRuntimeDir | Out-Null
  Copy-Item -LiteralPath $bundledRuntime -Destination (Join-Path $targetRuntimeDir 'node.exe') -Force
  if ($Link) { $nodeForPlugin = $bundledRuntime } else { $nodeForPlugin = Join-Path $targetRuntimeDir 'node.exe' }
  Write-Host ('  已内置 node.exe 到 ' + $targetRuntimeDir)
} else {
  Write-Host ('  使用系统 node: ' + $nodeForPlugin)
}

Write-Section '3/5 绑定运行时路径'
if ($Link) {
  Write-Host '  开发模式跳过（仓库内保持 node 关键字）'
} else {
  Update-PluginRuntimePaths -Root $target -NodeExe $nodeForPlugin
}

Write-Section '4/5 更新插件注册'
$manifest = [pscustomobject]@{
  name = 'tuner-market'
  description = 'Local marketplace for tuner'
  owner = [pscustomobject]@{ name = 'local' }
  plugins = @(
    [pscustomobject]@{
      name = 'tuner'
      description = 'AIWorkKit 空闲降温：回收内存、降优先级、挂起后台子进程，托盘与独立窗口可随时恢复'
      version = '1.0.0'
      source = './plugins/tuner'
    }
  )
}
New-Item -ItemType Directory -Force -Path (Join-Path $marketDir '.codebuddy-plugin') | Out-Null
Write-Json (Join-Path $marketDir '.codebuddy-plugin\marketplace.json') $manifest
Write-Host '  市场清单已写入'

New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

Backup-File $knownFile
$known = Read-Json $knownFile ([pscustomobject]@{})
Ensure-Prop $known 'tuner-market' ([pscustomobject]@{
  manifestName = 'tuner-market'
  type = 'directory'
  source = [pscustomobject]@{ source = 'directory'; path = $marketDir }
  installLocation = $marketDir
  description = 'Local marketplace for tuner'
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
$stale = @($settings.enabledPlugins.PSObject.Properties | Where-Object { $_.Name -like 'tuner@*' -and $_.Name -ne $key })
foreach ($item in $stale) {
  $settings.enabledPlugins.PSObject.Properties.Remove($item.Name)
  Write-Host ('  移除旧注册 ' + $item.Name)
}
Ensure-Prop $settings.enabledPlugins $key $true
Write-Json $settingsFile $settings
Write-Host '  settings.json 已更新（enabledPlugins）'

Write-Section '5/5 托盘'
$trayScript = Join-Path $target 'tray\tray.ps1'

if ($TrayAtLogin) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startup 'AIWorkKit Idle Tuner Tray.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = 'powershell.exe'
  $sc.Arguments = '-NoProfile -NoLogo -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $trayScript + '"'
  $sc.WorkingDirectory = $target
  $sc.WindowStyle = 7
  $sc.Description = 'AIWorkKit 空闲降温器托盘'
  $sc.Save()
  Write-Host ('  已加入开机启动: ' + $lnk)
} else {
  Write-Host '  未加入开机启动（插件已随 AIWorkKit 启动自动拉起托盘）'
}

if ($NoTray) {
  Write-Host '  已跳过启动（-NoTray）'
} else {
  # -WorkingDirectory keeps the tray from inheriting the installer's cwd, which
  # would otherwise lock the extracted package folder until the tray exits.
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $target -ArgumentList @(
    '-NoProfile', '-NoLogo', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $trayScript + '"')
  )
  Write-Host '  托盘已启动（任务栏通知区域）'
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '下一步：AIWorkKit 中 Ctrl+Shift+P -> Developer: Reload Window 让命令与 Hook 生效。' -ForegroundColor Yellow
Write-Host '重载后每次启动 AIWorkKit 都会自动拉起托盘（SessionStart -> autostart）。' -ForegroundColor Yellow
Write-Host ''
Write-Host ('独立窗口："' + $nodeForPlugin + '" "' + (Join-Path $target 'cli\tuner.js') + '" open')
Write-Host ('查看占用："' + $nodeForPlugin + '" "' + (Join-Path $target 'cli\tuner.js') + '" status')
Write-Host ('恢复    ："' + $nodeForPlugin + '" "' + (Join-Path $target 'cli\tuner.js') + '" restore')
