# ============================================================================
# install-rules.ps1 - 把同一份规则正文分发到各 AI 编程平台的约定位置
#
# 为什么需要它：规则正文（索引库在哪、工具怎么调、收尾怎么提交）是平台无关的，
# 只有「文件放哪、叫什么」不同。把正文写一次、按平台落盘，就不必维护多份。
#
# 支持的落盘方式：
#   file  独占文件（.mdc / .md），卸载时直接删
#   block 追加到聚合文件（AGENTS.md / CLAUDE.md / .clinerules），
#         用 <!-- AIWorkKit:BEGIN --> 包裹，升级替换、卸载删除，不碰用户原有内容
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install-rules.ps1 -Target "D:\Kit"
#   powershell -ExecutionPolicy Bypass -File install-rules.ps1 -Target "D:\Kit" -Platforms aiworkkit,codex
#   powershell -ExecutionPolicy Bypass -File install-rules.ps1 -Target "D:\Kit" -Platforms all
#
# -Platforms auto（默认）：只为「本机已存在的平台目录」写规则，另加部署目录一份通用 AGENTS.md
# ============================================================================
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$PackageRoot = '',
  [string]$Platforms = 'auto',
  [int]$PortCodevault = 57910,
  [int]$PortEco = 57821,
  [int]$PortTuner = 57822,
  [int]$PortErrvault = 57911,
  # 注意：不能叫 -Host，PowerShell 的 $Host 是只读内置变量，赋值会直接报错退出
  [string]$BindAddress = '127.0.0.1',
  [switch]$Json,
  # 只报告将写哪些平台/文件，不落盘。
  # 没有这个开关时，`-Platforms all` 会真的写进用户主目录（实测踩过一次）。
  [switch]$Dry
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
  $PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..') | Select-Object -ExpandProperty Path)
}
$Target = [System.IO.Path]::GetFullPath($Target)

$HOME_DIR = $env:USERPROFILE
$BEGIN_MARK = '<!-- AIWorkKit:BEGIN id=deploy-target -->'
$END_MARK = '<!-- AIWorkKit:END -->'

# ---------------------------------------------------------------- 平台表
# 从 config/platforms.json 读取，脚本里不再硬编码平台清单。
# 新增平台只改那个 JSON —— 以前这里和 platforms.json 各存一份，改一处漏一处。
#
# 目录写法支持三种占位：
#   ~             → 用户主目录
#   {target}      → 本次部署目录（-Target）
#   %LOCALAPPDATA% → 环境变量
function Expand-Dir {
  param([string]$Value)
  if (-not $Value) { return '' }
  $s = $Value.Replace('{target}', $Target)
  if ($s.StartsWith('~')) {
    $rest = $s.Substring(1).TrimStart('\', '/')
    $s = if ($rest) { Join-Path $env:USERPROFILE $rest } else { $env:USERPROFILE }
  }
  $s = [regex]::Replace($s, '%([^%]+)%', {
      param($m)
      $name = $m.Groups[1].Value
      $v = [System.Environment]::GetEnvironmentVariable($name)
      if ($v) { $v } else { $m.Value }
    })
  return [System.IO.Path]::GetFullPath($s)
}

$PlatformFile = Join-Path $PackageRoot 'config\platforms.json'
if (-not (Test-Path $PlatformFile)) {
  if ($Json) {
    [pscustomobject]@{ ok = $false; error = 'config\platforms.json 缺失'; written = @() } | ConvertTo-Json -Compress
  } else {
    Write-Host ('  [fail] 平台配置缺失：' + $PlatformFile) -ForegroundColor Red
  }
  exit 2
}

$platformRaw = Get-Content $PlatformFile -Raw -Encoding UTF8 | ConvertFrom-Json
$PLATFORM_TABLE = [ordered]@{}
foreach ($prop in $platformRaw.platforms.PSObject.Properties) {
  $p = $prop.Value
  $mode = 'file'
  if ($p.installMode -eq 'block') { $mode = 'block' }
  $dirPath = (Expand-Dir $p.rulesDir)
  $probePath = (Expand-Dir $p.probe)
  $PLATFORM_TABLE[$prop.Name] = @{
    label = [string]$p.label
    dir   = $dirPath
    file  = [string]$p.ruleFile
    mode  = $mode
    probe = $probePath
  }
}
if (-not $PLATFORM_TABLE.Contains('generic')) {
  Write-Host '  [fail] platforms.json 缺少 generic 条目（部署目录兜底）' -ForegroundColor Red
  exit 2
}

# ---------------------------------------------------------------- 正文
$tpl = Join-Path $PackageRoot 'rules\deploy-target.mdc'
if (-not (Test-Path $tpl)) {
  if ($Json) {
    [pscustomobject]@{ ok = $false; error = 'rules\deploy-target.mdc 缺失'; written = @() } | ConvertTo-Json -Compress
  } else {
    Write-Host '  [fail] 规则模板缺失：rules\deploy-target.mdc' -ForegroundColor Red
  }
  exit 2
}

$raw = Get-Content $tpl -Raw -Encoding UTF8
$raw = $raw.Replace('__TARGET__', $Target)
$raw = $raw.Replace('__PORT_CODEVAULT__', [string]$PortCodevault)
$raw = $raw.Replace('__PORT_ECO__', [string]$PortEco)
$raw = $raw.Replace('__PORT_TUNER__', [string]$PortTuner)
$raw = $raw.Replace('__PORT_ERRVAULT__', [string]$PortErrvault)
$raw = $raw.Replace('__HOST__', $BindAddress)
$raw = $raw.Replace('__BASE__', ('http://127.0.0.1:' + $PortCodevault))
$raw = $raw.Replace('__DEPLOYED__', (Get-Date).ToString('yyyy-MM-dd'))

# 聚合文件里不能有 YAML frontmatter，去掉后得到纯正文
$bodyOnly = ($raw -replace '(?s)^---\s*\r?\n.*?\r?\n---\s*\r?\n', '').Trim()

# ---------------------------------------------------------------- 选平台
$registry = $PLATFORM_TABLE.Keys | Where-Object { $_ -ne 'generic' }

$selected = @()
if ($Platforms -eq 'auto') {
  foreach ($key in $registry) {
    if (Test-Path $PLATFORM_TABLE[$key].probe) { $selected += $key }
  }
  # 一个都没检测到：至少给 AIWorkKit 和通用各写一份，免得装完没有任何指引
  if ($selected.Count -eq 0) { $selected = @('aiworkkit') }
  $selected += 'generic'
} elseif ($Platforms -eq 'all') {
  $selected = @($registry) + 'generic'
} else {
  $selected = $Platforms.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
}

$unknown = $selected | Where-Object { -not $PLATFORM_TABLE.Contains($_) }
if ($unknown) {
  Write-Host ('  [fail] 未知平台：' + ($unknown -join ', ')) -ForegroundColor Red
  Write-Host ('         可选：' + (($PLATFORM_TABLE.Keys) -join ', ') + '，或 auto / all')
  exit 2
}

# ---------------------------------------------------------------- 写入
$written = New-Object System.Collections.Generic.List[object]
$utf8 = New-Object System.Text.UTF8Encoding $false

function Write-FileMode {
  param([string]$Key, [hashtable]$Spec)
  $path = Join-Path $Spec.dir $Spec.file
  if ($Dry) {
    $script:written.Add([pscustomobject]@{ platform = $Key; label = $Spec.label; path = $path; mode = 'file(dry)' })
    return
  }
  if (-not (Test-Path $Spec.dir)) { New-Item -ItemType Directory -Force -Path $Spec.dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $raw, $utf8)
  $script:written.Add([pscustomobject]@{ platform = $Key; label = $Spec.label; path = $path; mode = 'file' })
}

function Write-BlockMode {
  param([string]$Key, [hashtable]$Spec)
  $path = Join-Path $Spec.dir $Spec.file
  if ($Dry) {
    $script:written.Add([pscustomobject]@{ platform = $Key; label = $Spec.label; path = $path; mode = 'block(dry)' })
    return
  }
  if (-not (Test-Path $Spec.dir)) { New-Item -ItemType Directory -Force -Path $Spec.dir | Out-Null }

  $existing = ''
  if (Test-Path $path) {
    $existing = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  }

  $block = $BEGIN_MARK + "`n" + $bodyOnly + "`n" + $END_MARK

  if ($existing -match [regex]::Escape($BEGIN_MARK)) {
    # 已存在受管区块：整体替换，保留块外内容
    $pattern = '(?s)' + [regex]::Escape($BEGIN_MARK) + '.*?' + [regex]::Escape($END_MARK)
    $merged = [regex]::Replace($existing, $pattern, $block.Replace('$', '$$'))
  } else {
    $sep = if ($existing.Trim().Length -gt 0) { "`n`n" } else { '' }
    $merged = $existing.TrimEnd() + $sep + $block + "`n"
  }

  [System.IO.File]::WriteAllText($path, $merged, $utf8)
  $script:written.Add([pscustomobject]@{ platform = $Key; label = $Spec.label; path = $path; mode = 'block' })
}

foreach ($key in $selected) {
  $spec = $PLATFORM_TABLE[$key]
  if ($spec.mode -eq 'file') { Write-FileMode -Key $key -Spec $spec }
  else { Write-BlockMode -Key $key -Spec $spec }
}

# ---------------------------------------------------------------- 输出
if ($Json) {
  [pscustomobject]@{
    ok        = $true
    target    = $Target
    platforms = $selected
    written   = $written
  } | ConvertTo-Json -Depth 5 -Compress
} else {
  Write-Host ''
  Write-Host '  规则分发' -ForegroundColor Cyan
  Write-Host '  ============================================' -ForegroundColor DarkGray
  foreach ($item in $written) {
    $tag = if ($item.mode -eq 'file') { '独占文件' } else { '追加区块' }
    Write-Host ("  [ok]   {0,-14} {1}" -f $item.label, $item.path) -ForegroundColor Green
    Write-Host ("         {0}" -f $tag) -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Host ('  共写入 {0} 个平台。' -f $written.Count) -ForegroundColor White
  Write-Host '  提示：聚合文件里的内容被 <!-- AIWorkKit:BEGIN --> 包裹，卸载时只删这一块。' -ForegroundColor DarkGray
  Write-Host ''
}

exit 0
