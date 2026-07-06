@echo off
setlocal

REM Double-click entrypoint for phone/SillyTavern/"mini phone" access.
REM The PowerShell script starts the local OpenAI bridge and then creates a
REM fresh HTTPS tunnel, because anonymous localhost.run URLs change after a
REM reboot or tunnel restart.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-public-openai-bridge.ps1"

echo.
echo Press any key to close this window.
pause >nul
