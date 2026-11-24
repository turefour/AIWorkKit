# AIWorkKit Eco - activate production mode.
# Restarts the monitor daemon, prints status and opens the dashboard window.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\activate.ps1
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

if (-not $node) {
  Write-Host 'node not found on PATH' -ForegroundColor Red
  exit 1
}

& $node "$root\cli\eco.js" stop | Out-Null
Start-Sleep -Seconds 1
& $node "$root\cli\eco.js" server --daemon
Start-Sleep -Seconds 2
& $node "$root\cli\eco.js" status
& $node "$root\cli\eco.js" open

Write-Host ''
Write-Host 'Hook 采集需要在 IDE 中重载窗口后生效：' -ForegroundColor Yellow
Write-Host '  Ctrl+Shift+P -> Developer: Reload Window' -ForegroundColor Yellow
Write-Host '重载后顶部「Hook 采集」指示灯会变绿。' -ForegroundColor Yellow
