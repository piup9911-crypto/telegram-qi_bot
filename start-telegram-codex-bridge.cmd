@echo off
setlocal

REM Safe desktop launcher for the Telegram -> Codex CLI bridge.
REM This is intentionally separate from the Gemini bridge, with its own lock,
REM state directory, bot token, and chat history.
set "BRIDGE_DIR=%~dp0"
set "CODEX_LOCK=%BRIDGE_DIR%codex-bridge-state\codex-bridge.lock.json"

REM Keep proxy variables aligned with bridge.env/codex-bridge.env. Telegram and
REM Codex both work more reliably on this machine when the local proxy is open.
set HTTP_PROXY=http://127.0.0.1:10808
set HTTPS_PROXY=http://127.0.0.1:10808
set NO_PROXY=localhost,127.0.0.1

echo Checking existing Codex Telegram bridge instance...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = $env:CODEX_LOCK; if (Test-Path -LiteralPath $lock) { try { $data = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json; $bridgePid = [int]$data.pid } catch { $bridgePid = 0 }; if ($bridgePid -gt 0 -and (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) { Write-Host ('Codex Telegram bridge is already running. PID: ' + $bridgePid); exit 10 } else { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue; Write-Host 'Removed stale Codex bridge lock.' } }"
set "LOCK_STATUS=%ERRORLEVEL%"
if "%LOCK_STATUS%"=="10" (
  echo.
  echo Keep using the current running bridge, or stop it before launching again.
  pause
  exit /b 0
)
if not "%LOCK_STATUS%"=="0" (
  echo Warning: lock check returned %LOCK_STATUS%. Continuing may fail if another bridge is running.
)

echo Checking Codex CLI...
if not exist "%APPDATA%\npm\codex.cmd" (
  echo.
  echo Codex CLI was not found at %APPDATA%\npm\codex.cmd
  echo Install it with: npm install -g @openai/codex
  pause
  exit /b 1
)

cd /d "%BRIDGE_DIR%"
echo Starting Codex Telegram bridge...
node src\codex\telegram-codex-bridge.cjs
echo.
echo Codex Telegram bridge stopped. Check codex-bridge-state\codex-bridge.log if you need details.
pause
