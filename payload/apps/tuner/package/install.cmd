@echo off
REM AIWorkKit Idle Tuner - installer wrapper (double click friendly).
REM Passes every argument through to install.ps1, e.g. install.cmd -TrayAtLogin
setlocal
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
endlocal
