@echo off
setlocal

REM Safe launcher for the Codex remote control agent
set "ROOT=%~dp0"
set "LOCK_PATH=%ROOT%codex-bridge-state\codex-control.lock.json"

echo Checking existing Codex control agent instance...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = $env:LOCK_PATH; if (Test-Path -LiteralPath $lock) { try { $data = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json; $bridgePid = [int]$data.pid } catch { $bridgePid = 0 }; if ($bridgePid -gt 0 -and (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) { Write-Host ('Codex control agent is already running. PID: ' + $bridgePid); exit 10 } else { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } }"
set "LOCK_STATUS=%ERRORLEVEL%"
if "%LOCK_STATUS%"=="10" (
  echo.
  echo Control agent is already running. Press any key to exit.
  pause >nul
  exit /b 0
)

cd /d "%ROOT%"
echo Starting Codex control agent...
node src\codex\codex-control-agent.cjs --watch
echo.
echo Codex control agent stopped.
pause
