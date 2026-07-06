@echo off
setlocal

REM This script exposes the local OpenAI-compatible Gemini bridge through
REM localhost.run so phone/web tools can access it without needing LAN access.
REM We keep the bridge target on 127.0.0.1:4141 because the bridge itself
REM already runs locally; the tunnel only needs to forward external traffic.

set "ROOT=%~dp0"
set "STATE=%ROOT%\st-bridge-state"
set "OUT=%STATE%\localhostrun.out.log"
set "ERR=%STATE%\localhostrun.err.log"

if not exist "%STATE%" mkdir "%STATE%"

REM We overwrite the previous logs on each run so the newest public URL is
REM easy to find at the top of the output file.
del "%OUT%" 2>nul
del "%ERR%" 2>nul

echo Starting localhost.run tunnel for http://127.0.0.1:4141 ...
echo.
echo A new public URL will appear below and also be written to:
echo   %OUT%
echo.

REM StrictHostKeyChecking=no avoids the first-run host prompt so the tunnel can
REM come up in a single step.
"C:\Windows\System32\OpenSSH\ssh.exe" -o StrictHostKeyChecking=no -R 80:127.0.0.1:4141 nokey@localhost.run 1>"%OUT%" 2>"%ERR%"

echo.
echo Tunnel process exited. Check these logs if it closed unexpectedly:
echo   %OUT%
echo   %ERR%
pause
