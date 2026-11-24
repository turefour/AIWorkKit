# ============================================================================
# AIWorkKit Idle Tuner - taskbar tray app
#
# Lives outside AIWorkKit on purpose: when background child processes are
# suspended, nothing inside the IDE can wake them up again, so the tray is the
# only reliable restore path.
#
# It shares core/tuner-core.ps1 with the plugin commands (single implementation).
#
# ASCII ONLY. Localized UI strings live in tray/labels.json (read as UTF-8),
# because Windows PowerShell 5.1 decodes BOM-less .ps1 files as ANSI.
#
# Launch:  powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1
# ============================================================================

param(
  # Self test hook: exit automatically after N seconds (0 = run until closed).
  [int]$ExitAfterSeconds = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'core\tuner-core.ps1')

# ----------------------------------------------------------------------------
# Single instance
# ----------------------------------------------------------------------------
$mutex = New-Object System.Threading.Mutex -ArgumentList $false, 'Local\AIWorkKitIdleTunerTray'
if (-not $mutex.WaitOne(0)) { exit 0 }

# ----------------------------------------------------------------------------
# Localized labels
# ----------------------------------------------------------------------------
$script:L = @{}
$labelsPath = Join-Path $PSScriptRoot 'labels.json'
if (Test-Path $labelsPath) {
  try {
    $obj = Get-Content -LiteralPath $labelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $script:L[$p.Name] = [string]$p.Value }
  } catch {
    Write-TunerLog ('labels.json parse failed: ' + $_.Exception.Message) 'WARN'
  }
}

function T {
  param([string]$Key, $Arg1 = $null, $Arg2 = $null)
  if (-not $script:L.ContainsKey($Key)) { return $Key }
  $text = $script:L[$Key]
  if ($null -eq $Arg1) { return $text }
  try {
    if ($null -eq $Arg2) { return ($text -f $Arg1) }
    return ($text -f $Arg1, $Arg2)
  } catch {
    return $text
  }
}

# ----------------------------------------------------------------------------
# UI helpers
# ----------------------------------------------------------------------------
function Show-Balloon {
  param([string]$Text, [string]$Kind = 'Info')
  try {
    $icon = [System.Windows.Forms.ToolTipIcon]::Info
    if ($Kind -eq 'Warn') { $icon = [System.Windows.Forms.ToolTipIcon]::Warning }
    if ($Kind -eq 'Error') { $icon = [System.Windows.Forms.ToolTipIcon]::Error }
    $script:notify.ShowBalloonTip(4000, (T 'title'), $Text, $icon)
  } catch { }
}

function Get-TrayUsage {
  $cfg = Get-TunerConfig
  $sum = 0.0
  $count = 0
  foreach ($name in @($cfg.processNames)) {
    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    foreach ($p in $procs) { $sum += $p.WorkingSet64 }
    $count += $procs.Count
  }
  $state = Get-TunerState
  $suspended = @($state.suspended | Where-Object { $_ })
  return @{
    mb        = [math]::Round($sum / 1MB, 1)
    count     = $count
    suspended = $suspended.Count
  }
}

function Update-TrayText {
  try {
    $u = Get-TrayUsage
    if ($u.count -eq 0) {
      $script:notify.Text = (T 'title') + ' | ' + (T 'statusOff')
      $script:statusItem.Text = (T 'statusOff')
      return
    }
    $text = if ($u.suspended -gt 0) { T 'statusIdle' $u.mb $u.suspended } else { T 'status' $u.mb }
    $script:notify.Text = (T 'title') + ' | ' + $text
    $script:statusItem.Text = $text
  } catch { }
}

function Invoke-Safe {
  param([scriptblock]$Body)
  try {
    & $Body
  } catch {
    Show-Balloon (T 'failed' $_.Exception.Message) 'Error'
    Write-TunerLog ('tray action failed: ' + $_.Exception.Message) 'ERROR'
  } finally {
    Update-TrayText
  }
}

# ----------------------------------------------------------------------------
# Actions
# ----------------------------------------------------------------------------
function Invoke-TrimAction {
  Invoke-Safe {
    $r = Invoke-TunerApply -Mode 'lite'
    if ($r.ok) {
      Show-Balloon (T 'trimDone' ($r.freedMB.ToString() + ' MB') ($r.settledFreedMB.ToString() + ' MB')) 'Info'
    } else {
      Show-Balloon (T 'notRunning') 'Warn'
    }
  }
}

function Invoke-DeepAction {
  Invoke-Safe {
    $r = Invoke-TunerApply -Mode 'deep'
    if ($r.ok) {
      Show-Balloon (T 'trimDone' ($r.freedMB.ToString() + ' MB') ($r.settledFreedMB.ToString() + ' MB')) 'Info'
    } else {
      Show-Balloon (T 'notRunning') 'Warn'
    }
  }
}

function Invoke-SuspendAction {
  param([string]$Level = 'background')

  $snap = Get-TunerSnapshot -SampleMs 0
  if (-not $snap.running) { Show-Balloon (T 'notRunning') 'Warn'; return }

  $targets = Select-TunerSuspendTargets -Snapshot $snap -Level $Level
  if ($targets.Count -eq 0) { Show-Balloon (T 'suspendDone' 0) 'Info'; return }

  $question = if ($Level -eq 'aggressive') { T 'confirmAggressive' } else { T 'confirmSuspend' $targets.Count }
  $answer = [System.Windows.Forms.MessageBox]::Show(
    $question, (T 'title'),
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning)
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  Invoke-Safe {
    $r = Invoke-TunerApply -Mode 'suspend' -SuspendLevel $Level
    Show-Balloon (T 'suspendDone' (@($r.suspended).Count)) 'Warn'
  }
}

function Invoke-RestoreAction {
  Invoke-Safe {
    $r = Invoke-TunerRestore
    Show-Balloon (T 'restoreDone' (@($r.resumed).Count)) 'Info'
  }
}

function Get-NodeExe {
  # Portable package ships its own runtime next to the plugin body; fall back to
  # whatever node is on PATH for repo / dev installs.
  $bundled = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe'
  if (Test-Path $bundled) { return $bundled }
  return 'node.exe'
}

function Open-DashboardWindow {
  Invoke-Safe {
    $cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'cli\tuner.js'
    if (-not (Test-Path $cli)) { throw ('cli not found: ' + $cli) }
    Start-Process -FilePath (Get-NodeExe) -ArgumentList @(('"' + $cli + '"'), 'open') -WindowStyle Hidden
  }
}

function Invoke-ToggleAuto {
  Invoke-Safe {
    $cfg = Get-TunerConfig
    $next = -not [bool]$cfg.autoMode
    $null = Set-TunerAutoMode -Enabled $next -Level $cfg.autoLevel
    $state = if ($next) { T 'on' } else { T 'off' }
    Show-Balloon (T 'autoState' $state) 'Info'
  }
}

# ----------------------------------------------------------------------------
# Build menu
# ----------------------------------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $true
$notify.Text = (T 'title')
$script:notify = $notify

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$headerItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'header')
$headerItem.Enabled = $false
[void]$menu.Items.Add($headerItem)

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'status' '0 MB')
$statusItem.Enabled = $false
$script:statusItem = $statusItem
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$windowItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'openWindow')
$windowItem.Add_Click({ Open-DashboardWindow })
[void]$menu.Items.Add($windowItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$trimItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'trim')
$trimItem.Add_Click({ Invoke-TrimAction })
[void]$menu.Items.Add($trimItem)

$deepItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'deep')
$deepItem.Add_Click({ Invoke-DeepAction })
[void]$menu.Items.Add($deepItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$suspendItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'suspend')
$suspendItem.Add_Click({ Invoke-SuspendAction -Level 'background' })
[void]$menu.Items.Add($suspendItem)

$suspendHardItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'suspendAggressive')
$suspendHardItem.Add_Click({ Invoke-SuspendAction -Level 'aggressive' })
[void]$menu.Items.Add($suspendHardItem)

$restoreItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'restore')
$restoreItem.Font = New-Object System.Drawing.Font($restoreItem.Font, [System.Drawing.FontStyle]::Bold)
$restoreItem.Add_Click({ Invoke-RestoreAction })
[void]$menu.Items.Add($restoreItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$autoItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'autoOn')
$autoItem.Add_Click({ Invoke-ToggleAuto })
[void]$menu.Items.Add($autoItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'openData')
$openItem.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $script:TunerRoot + '"') })
[void]$menu.Items.Add($openItem)

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem (T 'exit')
$exitItem.Add_Click({
    $script:notify.Visible = $false
    $script:notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  })
[void]$menu.Items.Add($exitItem)

$menu.Add_Opening({
    try {
      $cfg = Get-TunerConfig
      $autoItem.Text = if ([bool]$cfg.autoMode) { T 'autoOff' } else { T 'autoOn' }
    } catch { }
    Update-TrayText
  })

$notify.ContextMenuStrip = $menu
$notify.Add_MouseDoubleClick({ Open-DashboardWindow })

# Periodic refresh keeps the tooltip honest without a busy polling loop.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000
$timer.Add_Tick({ Update-TrayText })
$timer.Start()

if ($ExitAfterSeconds -gt 0) {
  $autoExit = New-Object System.Windows.Forms.Timer
  $autoExit.Interval = [int]($ExitAfterSeconds * 1000)
  $autoExit.Add_Tick({
      $script:notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    })
  $autoExit.Start()
}

Update-TrayText
Write-TunerLog 'tray started'

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run()

$mutex.ReleaseMutex()
