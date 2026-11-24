# AIWorkKit Eco - create a desktop shortcut for the standalone window.
# Run once; the shortcut then behaves like a normal desktop app.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'AIWorkKit Eco.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'scripts\eco-window.ps1') + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'AIWorkKit Eco 运行时监控'
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host ('shortcut created: ' + $link) -ForegroundColor Green
