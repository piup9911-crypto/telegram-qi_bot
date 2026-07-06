@echo off
cd /d "%~dp0"
node "%~dp0gemini-cli-openai-bridge.cjs"
echo.
echo Bridge process exited. Press any key to close this window.
pause >nul
