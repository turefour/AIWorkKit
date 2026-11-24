# ============================================================================
# AIWorkKit Idle Tuner - core engine
# One implementation shared by cli/tuner.js (plugin commands / hooks) and the
# system-tray app (tray/tray.ps1).
#
# Capabilities:
#   - discover every AIWorkKit (Electron) process and classify its role
#   - trim working sets back to the OS (EmptyWorkingSet / SetProcessWorkingSetSize)
#   - change CPU base priority class and enable EcoQoS power throttling
#   - suspend / resume background child processes (NtSuspendProcess)
#   - persist state so a restore is always deterministic and repeatable
#
# ASCII ONLY. Windows PowerShell 5.1 decodes BOM-less .ps1 files as ANSI, so any
# non-ASCII literal inside this file would be corrupted. Localized UI text lives
# in cli/tuner.js and tray/labels.json instead.
# ============================================================================

$ErrorActionPreference = 'Stop'

$script:TunerRoot   = Join-Path $env:LOCALAPPDATA 'AIWorkKitIdleTuner'
$script:StateFile   = Join-Path $script:TunerRoot 'state.json'
$script:ConfigFile  = Join-Path $script:TunerRoot 'config.json'
$script:LogFile     = Join-Path $script:TunerRoot 'tuner.log'
$script:CoreFile    = $PSCommandPath

if (-not (Test-Path $script:TunerRoot)) {
  New-Item -ItemType Directory -Path $script:TunerRoot -Force | Out-Null
}

# ----------------------------------------------------------------------------
# Native interop
# ----------------------------------------------------------------------------
if (-not ('TunerNative.Api' -as [type])) {
  Add-Type -Namespace TunerNative -Name Api -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_POWER_THROTTLING_STATE
{
    public uint Version;
    public uint ControlMask;
    public uint StateMask;
}

[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr hObject);

[DllImport("psapi.dll", SetLastError = true)]
public static extern bool EmptyWorkingSet(IntPtr hProcess);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetProcessWorkingSetSize(IntPtr hProcess, IntPtr dwMinimumWorkingSetSize, IntPtr dwMaximumWorkingSetSize);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetPriorityClass(IntPtr hProcess, uint dwPriorityClass);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint GetPriorityClass(IntPtr hProcess);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetProcessInformation(IntPtr hProcess, int processInformationClass, ref PROCESS_POWER_THROTTLING_STATE processInformation, uint processInformationSize);

[DllImport("ntdll.dll")]
public static extern int NtSuspendProcess(IntPtr processHandle);

[DllImport("ntdll.dll")]
public static extern int NtResumeProcess(IntPtr processHandle);

// ---- system-wide cache purge (standby / modified page lists) ----------
// EmptyWorkingSet only trims per-process working sets; the bulk of reclaimable
// memory on a busy box sits in the standby page list, which requires these.
[DllImport("ntdll.dll")]
public static extern uint NtSetSystemInformation(int infoClass, IntPtr info, int length);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool LookupPrivilegeValue(string systemName, string name, out long luid);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool AdjustTokenPrivileges(
    IntPtr tokenHandle, bool disableAll, ref TOKEN_PRIVILEGES newState,
    int bufferLength, IntPtr previousState, IntPtr returnLength);

// Win32 layout is Count(4) + LUID{DWORD,DWORD}(8) + Attributes(4) = 16 bytes.
// Using `long` for the LUID makes the CLR align it to 8 bytes and inject 4 bytes
// of padding, so AdjustTokenPrivileges sees a malformed buffer: it returns TRUE
// but GetLastError is ERROR_NOT_ALL_ASSIGNED (1300) and the privilege stays off.
[StructLayout(LayoutKind.Sequential)]
public struct TOKEN_PRIVILEGES
{
    public int Count;
    public int LuidLow;
    public int LuidHigh;
    public int Attributes;
}
'@
}

# Access rights (winnt.h)
$script:PROC_QUERY_INFO     = 0x0400
$script:PROC_SET_QUOTA      = 0x0100
$script:PROC_SET_INFO       = 0x0200
$script:PROC_SUSPEND_RESUME = 0x0800

# Priority classes (winbase.h)
$script:PriorityClasses = @{
  'idle'        = [uint32]0x00000040
  'belownormal' = [uint32]0x00004000
  'normal'      = [uint32]0x00000020
  'abovenormal' = [uint32]0x00008000
  'high'        = [uint32]0x00000080
}
$script:PriorityNames = @{
  0x00000040 = 'Idle'
  0x00004000 = 'BelowNormal'
  0x00000020 = 'Normal'
  0x00008000 = 'AboveNormal'
  0x00000080 = 'High'
  0x00000100 = 'RealTime'
}

# Global flag that lets Electron processes be seen by OpenProcess with the
# rights we need even though they run in a sandbox.
$script:DefaultProcessNames = @('AIWorkKit CN', 'AIWorkKit', 'Code')

# ----------------------------------------------------------------------------
# Logging / config / state helpers
# ----------------------------------------------------------------------------
function Write-TunerLog {
  param([string]$Message, [string]$Level = 'INFO')
  try {
    $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch { }
}

function Get-TunerDefaultConfig {
  return @{
    autoMode       = $false            # trim + low priority automatically when idle
    autoLevel      = 'lite'            # lite | deep (deep never suspends in auto mode)
    processNames   = $script:DefaultProcessNames
    minIdleSeconds = 120               # do not auto-apply sooner than this after the last prompt
    suspendLevel   = 'background'      # background | aggressive
    autoResumeMinutes = 0              # 0 = never auto resume
    trayOnStart    = $true             # SessionStart hook raises the tray icon
    windowOnStart  = $false            # also pop the standalone dashboard window
    port           = 47822             # local dashboard server port
  }
}

function Get-TunerConfig {
  $cfg = Get-TunerDefaultConfig
  if (-not (Test-Path $script:ConfigFile)) { return $cfg }
  try {
    $raw = Get-Content -LiteralPath $script:ConfigFile -Raw -Encoding UTF8
    if (-not $raw -or -not $raw.Trim()) { return $cfg }
    $obj = $raw | ConvertFrom-Json
    foreach ($k in @($cfg.Keys)) {
      $prop = $obj.PSObject.Properties[$k]
      if ($prop -and $null -ne $prop.Value) { $cfg[$k] = $prop.Value }
    }
  } catch {
    Write-TunerLog ('config parse failed: ' + $_.Exception.Message) 'WARN'
  }
  return $cfg
}

function Save-TunerConfig {
  param($Config)
  ($Config | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $script:ConfigFile -Encoding UTF8
}

function Get-TunerState {
  $def = @{
    busy        = $false
    autoMode    = $false
    suspended   = @()
    resumeAt    = $null
    lastApplyAt = $null
    lastTrimAt  = $null
    lastMode    = $null
    lastFreedMB = $null
  }
  if (-not (Test-Path $script:StateFile)) { return $def }
  try {
    $raw = Get-Content -LiteralPath $script:StateFile -Raw -Encoding UTF8
    if (-not $raw -or -not $raw.Trim()) { return $def }
    $obj = $raw | ConvertFrom-Json
    foreach ($k in @($def.Keys)) {
      $prop = $obj.PSObject.Properties[$k]
      if ($prop -and $null -ne $prop.Value) { $def[$k] = $prop.Value }
    }
  } catch {
    Write-TunerLog ('state parse failed: ' + $_.Exception.Message) 'WARN'
  }
  return $def
}

function Save-TunerState {
  param($State)
  ($State | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $script:StateFile -Encoding UTF8
}

# State is read-modify-written by the hook, the CLI, the server and the tray.
# Without a lock the last writer wins with a stale snapshot, which can silently
# drop a "suspended" record and leave processes throttled forever.
function Invoke-WithStateLock {
  param([scriptblock]$Body, [int]$Retries = 40)
  $lockFile = $script:StateFile + '.lock'
  for ($i = 0; $i -lt $Retries; $i++) {
    try {
      $handle = [System.IO.File]::Open($lockFile, 'CreateNew', 'Write', 'None')
      try {
        return (& $Body)
      } finally {
        $handle.Close()
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
      }
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 25
    }
  }
  Write-TunerLog 'state lock timeout, writing unlocked' 'WARN'
  return (& $Body)
}

function Update-TunerState {
  param([hashtable]$Patch)
  return Invoke-WithStateLock {
    $state = Get-TunerState
    foreach ($k in @($Patch.Keys)) { $state[$k] = $Patch[$k] }
    Save-TunerState $state
    $state
  }
}

# ----------------------------------------------------------------------------
# Process discovery
# ----------------------------------------------------------------------------
function Get-TunerProcessList {
  param([string[]]$Names)

  if (-not $Names -or $Names.Count -eq 0) { $Names = (Get-TunerConfig).processNames }
  if (-not $Names -or $Names.Count -eq 0) { $Names = $script:DefaultProcessNames }

  $all = New-Object System.Collections.ArrayList
  foreach ($name in $Names) {
    $safe = ($name -replace "'", "''")
    $found = @()
    # WMI can transiently fail with E_OUTOFMEMORY (0x8007000E) right after a big
    # working-set trim, so retry a few times before falling back to Get-Process.
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      try {
        $found = @(Get-CimInstance Win32_Process -Filter ("Name = '{0}.exe'" -f $safe) -ErrorAction Stop)
        break
      } catch {
        Write-TunerLog ('CIM query failed attempt=' + $attempt + ': ' + $_.Exception.Message) 'WARN'
        Start-Sleep -Milliseconds 250
        $found = @()
      }
    }

    if ($found.Count -eq 0) {
      $plain = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
      if ($plain.Count -gt 0) {
        Write-TunerLog ('CIM unavailable, degraded to Get-Process for ' + $name) 'WARN'
        foreach ($p in $plain) {
          $parent = 0
          try { $parent = [int]$p.Parent.Id } catch { }
          [void]$all.Add([pscustomobject]@{
            ProcessId        = $p.Id
            ParentProcessId  = $parent
            Name             = ($name + '.exe')
            CommandLine      = ''
            WorkingSetSize   = [uint64]$p.WorkingSet64
            PrivatePageCount = [uint64]$p.PrivateMemorySize64
          })
        }
        continue
      }
    }

    foreach ($p in $found) { [void]$all.Add($p) }
  }
  return ,$all.ToArray()
}

function Get-TunerRole {
  param(
    [string]$CommandLine,
    [int]$ParentId = 0,
    $IdSet = $null
  )

  $cl = if ($CommandLine) { $CommandLine } else { '' }

  if ($cl -match '--type=([a-zA-Z-]+)') {
    $type = $matches[1].ToLower()
    switch ($type) {
      'renderer'    { return 'renderer' }
      'gpu-process' { return 'gpu' }
      'utility' {
        if ($cl -match 'tsserver') { return 'tsserver' }
        if ($cl -match 'node\.mojom\.NodeService') { return 'node-service' }
        return 'utility'
      }
      'crashpad-handler' { return 'crashpad' }
      default { return $type }
    }
  }

  # No --type= argument: either the real Electron main process or a plain Node
  # script helper that Electron re-launched through the same executable.
  if ($cl -match 'tsserver') { return 'tsserver' }
  if ($cl -match 'extensionHost|bootstrap-fork|extension-host') { return 'extension-host' }
  if ($IdSet -and -not $IdSet.ContainsKey($ParentId)) { return 'main' }
  return 'helper'
}

function Get-TunerAncestorIds {
  param([int]$ProcessId, [int]$MaxDepth = 12)
  $ids = New-Object System.Collections.ArrayList
  $cursor = $ProcessId
  for ($i = 0; $i -lt $MaxDepth; $i++) {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $cursor) -ErrorAction SilentlyContinue
    if (-not $p) { break }
    $parent = [int]$p.ParentProcessId
    if ($parent -le 0 -or $parent -eq $cursor) { break }
    [void]$ids.Add($parent)
    $cursor = $parent
  }
  return ,$ids.ToArray()
}

function Get-TunerSnapshot {
  param([int]$SampleMs = 400, [string[]]$Names)

  $procs = Get-TunerProcessList -Names $Names
  if ($procs.Count -eq 0) {
    return @{
      running = $false; processes = @(); totalMB = 0; cpuPercent = 0
      count = 0; suspended = @()
    }
  }

  $state = Get-TunerState
  $suspendedIds = @()
  foreach ($entry in @($state.suspended)) {
    if ($entry -and $entry.pid) { $suspendedIds += [int]$entry.pid }
  }

  $ids = @($procs | ForEach-Object { [int]$_.ProcessId })
  $cores = [Environment]::ProcessorCount
  $cpu1 = @{}
  foreach ($p in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) {
    $cpu1[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds
  }
  Start-Sleep -Milliseconds $SampleMs
  $live = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
  $cpu2 = @{}
  foreach ($p in $live) { $cpu2[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds }

  $list = New-Object System.Collections.ArrayList
  $totalMB = 0.0
  $cpuTotal = 0.0

  $idSet = @{}
  foreach ($proc in $procs) { $idSet[[int]$proc.ProcessId] = $true }

  foreach ($proc in $procs) {
    $procId = [int]$proc.ProcessId
    $role = Get-TunerRole -CommandLine $proc.CommandLine -ParentId ([int]$proc.ParentProcessId) -IdSet $idSet

    $cpu1v = if ($cpu1.ContainsKey($procId)) { $cpu1[$procId] } else { $null }
    $cpu2v = if ($cpu2.ContainsKey($procId)) { $cpu2[$procId] } else { $null }
    $cpuPct = 0.0
    if ($null -ne $cpu1v -and $null -ne $cpu2v -and $SampleMs -gt 0) {
      $cpuPct = [math]::Round((($cpu2v - $cpu1v) / $SampleMs) * 100.0 / $cores, 1)
    }

    $probe = @($live | Where-Object { $_.Id -eq $procId })
    $priority = 'unknown'
    $isEco = $false
    if ($probe.Count -gt 0) {
      try { $priority = $probe[0].PriorityClass.ToString() } catch { }
      # BelowNormal/Idle is how we mark an intentionally throttled process.
      $isEco = ($priority -eq 'Idle')
    }

    $wsMB = [math]::Round([double]$proc.WorkingSetSize / 1MB, 1)
    $totalMB += $wsMB
    $cpuTotal += $cpuPct

    [void]$list.Add([pscustomobject]@{
      pid       = $procId
      ppid      = [int]$proc.ParentProcessId
      role      = $role
      name      = $proc.Name
      wsMB      = $wsMB
      privateMB = [math]::Round([double]$proc.PrivatePageCount / 1MB, 1)
      cpuPct    = $cpuPct
      priority  = $priority
      throttled = $isEco
      suspended = ($suspendedIds -contains $procId)
      commandLine = if ($proc.CommandLine) { $proc.CommandLine } else { '' }
    })
  }

  $mainProc = @($list | Where-Object { $_.role -eq 'main' } | Sort-Object wsMB -Descending)
  $mainPid = if ($mainProc.Count -gt 0) { $mainProc[0].pid } else { $null }

  return @{
    running     = $true
    mainPid     = $mainPid
    count       = $list.Count
    totalMB     = [math]::Round($totalMB, 1)
    cpuPercent  = [math]::Round($cpuTotal, 1)
    suspended   = @($list | Where-Object { $_.suspended } | ForEach-Object { $_.pid })
    processes   = $list.ToArray()
  }
}

# ----------------------------------------------------------------------------
# Primitive operations
# ----------------------------------------------------------------------------
function Invoke-TunerTrimProcess {
  param([int]$ProcessId)

  $access = [uint32]($script:PROC_QUERY_INFO -bor $script:PROC_SET_QUOTA)
  $h = [TunerNative.Api]::OpenProcess($access, $false, [uint32]$ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    $ok = [TunerNative.Api]::EmptyWorkingSet($h)
    if (-not $ok) {
      $null = [TunerNative.Api]::SetProcessWorkingSetSize($h, [IntPtr](-1), [IntPtr](-1))
      $ok = $true
    }
    return $ok
  } catch {
    Write-TunerLog ('trim pid ' + $ProcessId + ' failed: ' + $_.Exception.Message) 'WARN'
    return $false
  } finally {
    [void][TunerNative.Api]::CloseHandle($h)
  }
}

function Set-TunerPriority {
  param([int]$ProcessId, [string]$Class = 'idle')

  $key = $Class.ToLower()
  if (-not $script:PriorityClasses.ContainsKey($key)) { $key = 'normal' }
  $h = [TunerNative.Api]::OpenProcess([uint32]$script:PROC_SET_INFO, $false, [uint32]$ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    return [TunerNative.Api]::SetPriorityClass($h, [uint32]$script:PriorityClasses[$key])
  } catch {
    return $false
  } finally {
    [void][TunerNative.Api]::CloseHandle($h)
  }
}

function Set-TunerEco {
  param([int]$ProcessId, [bool]$Enable = $true)

  $h = [TunerNative.Api]::OpenProcess([uint32]$script:PROC_SET_INFO, $false, [uint32]$ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    $st = New-Object TunerNative.Api+PROCESS_POWER_THROTTLING_STATE
    $st.Version = 1
    $st.ControlMask = 1
    $st.StateMask = if ($Enable) { [uint32]1 } else { [uint32]0 }
    $size = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($st)
    return [TunerNative.Api]::SetProcessInformation($h, 4, [ref]$st, $size)
  } catch {
    return $false
  } finally {
    [void][TunerNative.Api]::CloseHandle($h)
  }
}

function Invoke-TunerSuspendProcess {
  param([int]$ProcessId)
  $h = [TunerNative.Api]::OpenProcess([uint32]$script:PROC_SUSPEND_RESUME, $false, [uint32]$ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    $rc = [TunerNative.Api]::NtSuspendProcess($h)
    return ($rc -eq 0)
  } catch {
    return $false
  } finally {
    [void][TunerNative.Api]::CloseHandle($h)
  }
}

function Invoke-TunerResumeProcess {
  param([int]$ProcessId)
  $h = [TunerNative.Api]::OpenProcess([uint32]$script:PROC_SUSPEND_RESUME, $false, [uint32]$ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    $rc = [TunerNative.Api]::NtResumeProcess($h)
    return ($rc -eq 0)
  } catch {
    return $false
  } finally {
    [void][TunerNative.Api]::CloseHandle($h)
  }
}

# ----------------------------------------------------------------------------
# Suspend target selection
# ----------------------------------------------------------------------------
function Select-TunerSuspendTargets {
  param($Snapshot, [string]$Level = 'background')

  $protected = New-Object System.Collections.ArrayList
  [void]$protected.Add($PID)
  foreach ($a in (Get-TunerAncestorIds -ProcessId $PID)) { [void]$protected.Add($a) }

  $safeRoles = @('node-service', 'tsserver', 'utility', 'helper', 'extension-host')
  if ($Level -eq 'aggressive') { $safeRoles += @('renderer') }

  $targets = @($Snapshot.processes | Where-Object {
      $_.role -ne 'main' -and
      $_.role -ne 'gpu' -and
      $safeRoles -contains $_.role -and
      -not $_.suspended -and
      -not ($protected -contains $_.pid)
    })

  return ,$targets
}

# ----------------------------------------------------------------------------
# High level actions
# ----------------------------------------------------------------------------
# SystemMemoryListInformation = 0x50；命令值见 winnt.h 的 MEMORY_LIST_COMMAND
$script:MEMORY_LIST_INFO = 80
$script:MEM_PURGE_STANDBY = 4
$script:MEM_PURGE_LOW_STANDBY = 5
$script:MEM_FLUSH_MODIFIED = 3

function Enable-TunerPrivilege {
  param([string]$Name)

  try {
    # TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY
    $token = [IntPtr]::Zero
    $self = [System.Diagnostics.Process]::GetCurrentProcess().Handle
    if (-not [TunerNative.Api]::OpenProcessToken($self, 0x0020 -bor 0x0008, [ref]$token)) { return $false }

    $luid = 0L
    if (-not [TunerNative.Api]::LookupPrivilegeValue($null, $Name, [ref]$luid)) { return $false }

    $tp = New-Object TunerNative.Api+TOKEN_PRIVILEGES
    $tp.Count = 1
    # LUID 是高低两个 DWORD，拆开填，避免 CLR 对齐填充
    $tp.LuidLow = [int]($luid -band 0xFFFFFFFFL)
    $tp.LuidHigh = [int](($luid -shr 32) -band 0xFFFFFFFFL)
    $tp.Attributes = 0x00000002  # SE_PRIVILEGE_ENABLED

    $ok = [TunerNative.Api]::AdjustTokenPrivileges($token, $false, [ref]$tp, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    # AdjustTokenPrivileges 返回 true 但可能一个都没启用，必须查 last error
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    return ($ok -and $err -eq 0)
  } catch {
    return $false
  }
}

<#
  Purge one system-wide memory list.

  Requires SeProfileSingleProcessPrivilege (present for administrators). When it
  is not held the call simply fails and the caller keeps the working-set-only
  result — never an error the user has to deal with.
#>
function Clear-TunerSystemCache {
  param([int]$Command)

  if (-not (Enable-TunerPrivilege 'SeProfileSingleProcessPrivilege')) { return $false }

  $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  try {
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buffer, $Command)
    $status = [TunerNative.Api]::NtSetSystemInformation($script:MEMORY_LIST_INFO, $buffer, 4)
    return ($status -eq 0)
  } catch {
    return $false
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
}

function Invoke-TunerTrim {
  param(
    [string]$Scope = 'all',
    # 是否连带清理系统级缓存（待机页表/已修改页表）。管理员权限下效果最明显。
    [switch]$SystemCache
  )

  $snap = Get-TunerSnapshot -SampleMs 0
  $targets = @($snap.processes)
  if ($Scope -eq 'background') {
    $targets = @($targets | Where-Object { $_.role -ne 'renderer' -and $_.role -ne 'gpu' -and $_.role -ne 'main' })
  }

  $okCount = 0
  foreach ($t in $targets) {
    if (Invoke-TunerTrimProcess -ProcessId $t.pid) { $okCount++ }
  }

  # 系统级缓存：工作集只是「进程正在用的页」，真正的大头是待机页表。
  # 三项分开调用，任一失败不影响其它两项。
  $purged = 0
  if ($SystemCache) {
    if (Clear-TunerSystemCache $script:MEM_PURGE_STANDBY) { $purged++ }
    if (Clear-TunerSystemCache $script:MEM_PURGE_LOW_STANDBY) { $purged++ }
    if (Clear-TunerSystemCache $script:MEM_FLUSH_MODIFIED) { $purged++ }
  }

  Start-Sleep -Milliseconds 600

  $after = Get-TunerSnapshot -SampleMs 0
  $freed = [math]::Round($snap.totalMB - $after.totalMB, 1)

  # Working sets start faulting back in immediately; report the settled value too
  # so the number the user sees is honest instead of a 600ms snapshot.
  Start-Sleep -Milliseconds 2000
  $settled = Get-TunerSnapshot -SampleMs 0

  $null = Update-TunerState @{ lastTrimAt = (Get-Date).ToString('o'); lastFreedMB = $freed }
  Write-TunerLog ('trim scope=' + $Scope + ' targets=' + $targets.Count + ' ok=' + $okCount + ' freedMB=' + $freed + ' settledMB=' + $settled.totalMB)

  return @{
    action    = 'trim'
    scope     = $Scope
    targets   = $targets.Count
    trimmed   = $okCount
    beforeMB  = $snap.totalMB
    afterMB   = $after.totalMB
    settledMB = $settled.totalMB
    freedMB   = $freed
    settledFreedMB = [math]::Round($snap.totalMB - $settled.totalMB, 1)
    # 0 = 未请求；1~3 = 成功清理的系统缓存列表数量（需要管理员权限）
    systemCache = $purged
  }
}

function Invoke-TunerApply {
  param(
    [ValidateSet('lite', 'deep', 'suspend')] [string]$Mode = 'lite',
    [string]$SuspendLevel = 'background',
    [int]$AutoResumeMinutes = 0
  )

  $snap = Get-TunerSnapshot -SampleMs 0
  if (-not $snap.running) {
    return @{ action = 'apply'; mode = $Mode; ok = $false; reason = 'AIWorkKit is not running' }
  }

  $priorityClass = if ($Mode -eq 'deep') { 'idle' } else { 'belownormal' }

  $trimmed = 0
  $prioritySet = 0
  $ecoSet = 0
  foreach ($p in $snap.processes) {
    if (Invoke-TunerTrimProcess -ProcessId $p.pid) { $trimmed++ }
    if (Set-TunerPriority -ProcessId $p.pid -Class $priorityClass) { $prioritySet++ }
    if (Set-TunerEco -ProcessId $p.pid -Enable $true) { $ecoSet++ }
  }

  $suspendedIds = @()
  if ($Mode -eq 'suspend') {
    $targets = Select-TunerSuspendTargets -Snapshot $snap -Level $SuspendLevel
    $records = @()
    foreach ($t in $targets) {
      if (Invoke-TunerSuspendProcess -ProcessId $t.pid) {
        $suspendedIds += $t.pid
        $records += @{ pid = $t.pid; role = $t.role; at = (Get-Date).ToString('o') }
      }
    }
    if ($records.Count -gt 0) {
      $state = Get-TunerState
      $existing = @()
      foreach ($e in @($state.suspended)) { if ($e) { $existing += $e } }
      $null = Update-TunerState @{ suspended = @($existing + $records) }
    }
    if ($suspendedIds.Count -gt 0 -and $AutoResumeMinutes -gt 0) {
      Start-TunerResumeWatcher -Minutes $AutoResumeMinutes
    }
  }

  Start-Sleep -Milliseconds 700
  $after = Get-TunerSnapshot -SampleMs 0
  $freed = [math]::Round($snap.totalMB - $after.totalMB, 1)

  Start-Sleep -Milliseconds 2000
  $settled = Get-TunerSnapshot -SampleMs 0

  $null = Update-TunerState @{
    lastApplyAt = (Get-Date).ToString('o')
    lastMode    = $Mode
    lastFreedMB = $freed
  }
  Write-TunerLog ('apply mode=' + $Mode + ' freedMB=' + $freed + ' suspended=' + $suspendedIds.Count)

  return @{
    action       = 'apply'
    mode         = $Mode
    ok           = $true
    priority     = $priorityClass
    processes    = $snap.count
    trimmed      = $trimmed
    prioritySet  = $prioritySet
    ecoSet       = $ecoSet
    suspended    = $suspendedIds
    beforeMB     = $snap.totalMB
    afterMB      = $after.totalMB
    settledMB    = $settled.totalMB
    freedMB      = $freed
    settledFreedMB = [math]::Round($snap.totalMB - $settled.totalMB, 1)
    autoResume   = $AutoResumeMinutes
  }
}

function Invoke-TunerRestore {

  $state = Get-TunerState
  $resumed = @()
  $failed  = @()
  foreach ($entry in @($state.suspended)) {
    if (-not $entry -or -not $entry.pid) { continue }
    $procId = [int]$entry.pid
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { continue }
    # A suspended process needs the resume call even if it looks healthy.
    if (Invoke-TunerResumeProcess -ProcessId $procId) { $resumed += $procId } else { $failed += $procId }
    $null = Set-TunerPriority -ProcessId $procId -Class 'normal'
    $null = Set-TunerEco -ProcessId $procId -Enable $false
  }

  $snap = Get-TunerSnapshot -SampleMs 0
  foreach ($p in @($snap.processes)) {
    $null = Set-TunerPriority -ProcessId $p.pid -Class 'normal'
    $null = Set-TunerEco -ProcessId $p.pid -Enable $false
  }

  $null = Update-TunerState @{ suspended = @(); resumeAt = $null }
  Write-TunerLog ('restore resumed=' + $resumed.Count + ' failed=' + $failed.Count)

  return @{
    action  = 'restore'
    ok      = ($failed.Count -eq 0)
    resumed = $resumed
    failed  = $failed
    totalMB = $snap.totalMB
  }
}

function Start-TunerResumeWatcher {
  param([int]$Minutes)

  if ($Minutes -le 0) { return }
  $deadline = (Get-Date).AddMinutes($Minutes)
  $null = Update-TunerState @{ resumeAt = $deadline.ToString('o') }

  $scriptPath = Join-Path $PSScriptRoot 'tuner.ps1'
  if (-not (Test-Path $scriptPath)) { return }
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $scriptPath + '"'),
    '-Action', 'resume-watch', '-Minutes', $Minutes.ToString()
  ) | Out-Null
}

# The auto-resume watcher is a DETACHED PowerShell process: Task Manager, a
# logoff or a crash can kill it, leaving processes suspended with a stale
# resumeAt and nobody to wake them. Every entry point therefore runs a lazy
# check: if the deadline passed and something is still suspended, restore now.
function Invoke-TunerLazyResume {
  $state = Get-TunerState
  if (-not $state.resumeAt) { return $false }
  if (@($state.suspended).Count -eq 0) { return $false }

  $deadline = $null
  try {
    $deadline = [datetime]::Parse($state.resumeAt, [System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    return $false
  }
  if ((Get-Date) -lt $deadline) { return $false }

  Write-TunerLog 'lazy resume triggered (watcher may have died)'
  $null = Invoke-TunerRestore
  return $true
}

function Invoke-TunerResumeWatch {
  param([int]$Minutes)

  $deadline = (Get-Date).AddMinutes($Minutes)
  Write-TunerLog ('resume watcher armed for ' + $Minutes + ' min')
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 15
    $state = Get-TunerState
    if (@($state.suspended).Count -eq 0) { Write-TunerLog 'resume watcher cancelled'; return }
    if ($state.resumeAt -and $state.resumeAt -ne $deadline.ToString('o')) {
      Write-TunerLog 'resume watcher superseded'
      return
    }
  }
  $null = Invoke-TunerRestore
  Write-TunerLog 'resume watcher fired'
}

function Set-TunerAutoMode {
  param([bool]$Enabled, [string]$Level = 'lite')

  $cfg = Get-TunerConfig
  $cfg.autoMode = $Enabled
  if ($Level) { $cfg.autoLevel = $Level }
  Save-TunerConfig $cfg
  $null = Update-TunerState @{ autoMode = $Enabled }
  Write-TunerLog ('auto mode = ' + $Enabled + ' level=' + $cfg.autoLevel)
  return @{ action = 'auto'; autoMode = $Enabled; level = $cfg.autoLevel }
}

function Get-TunerStatus {

  $cfg = Get-TunerConfig
  $state = Get-TunerState
  $snap = Get-TunerSnapshot -SampleMs 400

  $byRole = @{}
  foreach ($p in @($snap.processes)) {
    if (-not $byRole.ContainsKey($p.role)) { $byRole[$p.role] = @{ count = 0; mb = 0.0 } }
    $byRole[$p.role].count += 1
    $byRole[$p.role].mb = [math]::Round($byRole[$p.role].mb + $p.wsMB, 1)
  }

  $top = @($snap.processes | Sort-Object wsMB -Descending | Select-Object -First 8 |
    Select-Object pid, role, wsMB, privateMB, cpuPct, priority, suspended)

  # Compact list for the dashboard window (command lines dropped to keep the
  # payload small, they are only useful in the PowerShell object model).
  $compact = @($snap.processes |
    Select-Object pid, ppid, role, wsMB, privateMB, cpuPct, priority, suspended)

  $roles = @()
  foreach ($k in $byRole.Keys) {
    $roles += @{ role = $k; count = $byRole[$k].count; mb = $byRole[$k].mb }
  }

  $totalPrivateMB = 0.0
  foreach ($p in @($snap.processes)) { $totalPrivateMB += $p.privateMB }

  return @{
    running        = $snap.running
    mainPid        = $snap.mainPid
    count          = $snap.count
    totalMB        = $snap.totalMB
    privateMB      = [math]::Round($totalPrivateMB, 1)
    cpuPercent     = $snap.cpuPercent
    roles          = @($roles | Sort-Object { $_.mb } -Descending)
    top            = $top
    processes      = $compact
    suspended      = @($snap.suspended)
    busy           = $state.busy
    autoMode       = [bool]$cfg.autoMode
    autoLevel      = $cfg.autoLevel
    suspendLevel   = $cfg.suspendLevel
    resumeAt       = $state.resumeAt
    lastApplyAt    = $state.lastApplyAt
    lastTrimAt     = $state.lastTrimAt
    lastMode       = $state.lastMode
    lastFreedMB    = $state.lastFreedMB
    processNames   = @($cfg.processNames)
    dataDir        = $script:TunerRoot
    machineCores   = [Environment]::ProcessorCount
    timestamp      = (Get-Date).ToString('o')
  }
}
