@echo off
REM AIWorkKit Idle Tuner - uninstaller wrapper (double click friendly).
REM Pass -Purge to also delete runtime data under %LOCALAPPDATA%\AIWorkKitIdleTuner
setlocal
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
endlocal
