# AIWorkKit Eco - launch the standalone monitor window.
# Ensures the daemon is running, then opens the chromeless app window.
# Suitable as a desktop shortcut target (see create-shortcut.ps1).
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

if (-not $node) {
  Write-Host 'node not found on PATH' -ForegroundColor Red
  exit 1
}

& $node "$root\cli\eco.js" server --daemon | Out-Null
& $node "$root\cli\eco.js" open
