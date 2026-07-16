@echo off
setlocal

REM Safe desktop launcher for the Telegram -> Gemini CLI bridge.
REM Important: do not remove the lock check below without replacing it with
REM another single-instance guard. Telegram bot polling only allows one active
REM bridge process; duplicate launchers can cause 409 polling conflicts.
set "BRIDGE_DIR=%~dp0"
set "BRIDGE_LOCK=%BRIDGE_DIR%bridge-state\bridge.lock.json"

REM This bridge uses the local Clash mixed port. Telegram is unstable through
REM HTTP CONNECT on this machine, so use SOCKS5H to keep DNS and TLS inside the
REM proxy path.
REM If you switch to direct network mode later, also update bridge.env and these
REM three variables together so the desktop launcher matches the bridge config.
set HTTP_PROXY=socks5h://127.0.0.1:10808
set HTTPS_PROXY=socks5h://127.0.0.1:10808
set ALL_PROXY=socks5h://127.0.0.1:10808
set NO_PROXY=localhost,127.0.0.1

echo Checking existing Telegram bridge instance...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lock = $env:BRIDGE_LOCK; if (Test-Path -LiteralPath $lock) { try { $data = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json; $bridgePid = [int]$data.pid } catch { $bridgePid = 0 }; if ($bridgePid -gt 0 -and (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) { Write-Host ('Telegram bridge is already running. PID: ' + $bridgePid); exit 10 } else { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue; Write-Host 'Removed stale bridge lock.' } }"
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

echo Checking local proxy 127.0.0.1:10808...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client = New-Object Net.Sockets.TcpClient; $async = $client.BeginConnect('127.0.0.1', 10808, $null, $null); if (-not $async.AsyncWaitHandle.WaitOne(1000, $false)) { $client.Close(); exit 1 }; try { $client.EndConnect($async); $client.Close(); exit 0 } catch { $client.Close(); exit 1 }"
if errorlevel 1 (
  echo.
  echo Proxy 127.0.0.1:10808 is not reachable.
  echo Start your proxy first, then run this launcher again.
  pause
  exit /b 1
)

cd /d "%BRIDGE_DIR%"
echo Starting Telegram bridge...
node src\gem\telegram-gem-bridge.cjs
echo.
echo Telegram bridge stopped. Check bridge-state\bridge.log if you need details.
pause
