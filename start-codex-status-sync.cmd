@echo off
setlocal

REM Safe launcher for the Codex status heartbeat
set "ROOT=%~dp0"
set "LOCK_PATH=%ROOT%codex-bridge-state\codex-status.lock.json"

echo Checking existing Codex status sync instance...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = $env:LOCK_PATH; if (Test-Path -LiteralPath $lock) { try { $data = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json; $bridgePid = [int]$data.pid } catch { $bridgePid = 0 }; if ($bridgePid -gt 0 -and (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) { Write-Host ('Codex status sync is already running. PID: ' + $bridgePid); exit 10 } else { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } }"
set "LOCK_STATUS=%ERRORLEVEL%"
if "%LOCK_STATUS%"=="10" (
  echo.
  echo Status sync is already running. Press any key to exit.
  pause >nul
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = $env:LOCK_PATH; $dir = Split-Path $lock; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }; @{ pid = $PID; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $lock"

cd /d "%ROOT%"
echo Starting Codex status sync loop...
node codex-status-sync.cjs --watch
echo.
echo Codex status sync stopped.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = $env:LOCK_PATH; if (Test-Path -LiteralPath $lock) { try { $data = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json; if ($data.pid -eq $PID) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } } catch {} }"
pause
