@echo off
setlocal
cd /d "%~dp0"

REM Open the local manager page a moment after startup so the service has time
REM to begin listening before the browser tries to connect.
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4142/'"

echo Starting independent memory manager on http://127.0.0.1:4142
node "%~dp0independent-memory-manager.cjs"

echo.
echo Independent memory manager exited. Press any key to close.
pause >nul
