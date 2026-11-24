@echo off
rem CodeVault launcher: serve the index on 127.0.0.1:57910 and open a browser.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [codevault] Node.js not found in PATH. Install Node 18+ and retry.
  pause
  exit /b 1
)

node tools\serve.mjs --open
if errorlevel 1 pause
