# ============================================================================
# AIWorkKit Idle Tuner - command line entry point
# Every action returns a plain object; with -Json the object is printed as
# pure JSON on stdout (no banners), which is what cli/tuner.js consumes.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File core\tuner.ps1 -Action status -Json
#   ... -Action apply  -Mode lite|deep|suspend  -Level background|aggressive  -AutoResume 30
#   ... -Action trim   -Scope all|background
#   ... -Action restore
#   ... -Action auto   -Enabled 1 -Level lite
#   ... -Action resume-watch -Minutes 30
#
# ASCII ONLY - see the header of tuner-core.ps1 for the reason.
# ============================================================================
param(
  [ValidateSet('status', 'trim', 'apply', 'restore', 'suspend', 'resume', 'resume-watch', 'auto', 'config')]
  [string]$Action = 'status',
  [ValidateSet('all', 'background')]
  [string]$Scope = 'all',
  [ValidateSet('lite', 'deep', 'suspend')]
  [string]$Mode = 'lite',
  [ValidateSet('background', 'aggressive')]
  [string]$Level = 'background',
  [ValidateSet('idle', 'belownormal', 'normal')]
  [string]$Class = 'idle',
  [int]$AutoResume = 0,
  [int]$Minutes = 0,
  [int]$Enabled = -1,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch { }

. (Join-Path $PSScriptRoot 'tuner-core.ps1')

function Write-TunerResult {
  param($Result)

  if ($Json) {
    $text = $Result | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.Write($text)
    [Console]::Out.Flush()
    return
  }

  foreach ($key in @($Result.Keys)) {
    Write-Host ('{0}: {1}' -f $key, $Result[$key])
  }
}

try {
  $result = $null

  # Lazy safety net: if the resume deadline already passed and something is still
  # suspended, the detached watcher is probably dead -> restore right here.
  if (@('status', 'trim', 'apply', 'suspend', 'auto', 'config') -contains $Action) {
    $null = Invoke-TunerLazyResume
  }

  switch ($Action) {
    'status' { $result = Get-TunerStatus }

    'trim' { $result = Invoke-TunerTrim -Scope $Scope }

    'apply' { $result = Invoke-TunerApply -Mode $Mode -SuspendLevel $Level -AutoResumeMinutes $AutoResume }

    'suspend' {
      $result = Invoke-TunerApply -Mode 'suspend' -SuspendLevel $Level -AutoResumeMinutes $AutoResume
    }

    'restore' { $result = Invoke-TunerRestore }

    'resume' { $result = Invoke-TunerRestore }

    'resume-watch' { $null = Invoke-TunerResumeWatch -Minutes $Minutes; $result = @{ action = 'resume-watch'; ok = $true; minutes = $Minutes } }

    'auto' {
      $flag = if ($Enabled -eq 1) { $true } elseif ($Enabled -eq 0) { $false } else { -not (Get-TunerConfig).autoMode }
      # Auto mode never suspends: hooks run inside a node service, suspending it
      # would prevent the next UserPromptSubmit hook from ever firing again.
      $autoLevel = if ($Mode -eq 'deep') { 'deep' } else { 'lite' }
      $result = Set-TunerAutoMode -Enabled $flag -Level $autoLevel
    }

    'config' { $result = Get-TunerConfig }

    default { $result = @{ ok = $false; error = ('unknown action: ' + $Action) } }
  }

  Write-TunerResult $result
  exit 0
} catch {
  $msg = $_.Exception.Message
  Write-TunerLog ($Action + ' failed: ' + $msg) 'ERROR'
  if ($Json) {
    [Console]::Out.Write((@{ ok = $false; action = $Action; error = $msg } | ConvertTo-Json -Compress))
  } else {
    Write-Host ('ERROR: ' + $msg) -ForegroundColor Red
  }
  exit 1
}
