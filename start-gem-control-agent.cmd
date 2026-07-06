@echo off
setlocal

REM Keep this window open when you want the website to control local bridge
REM startup. The website cannot wake the PC by itself; this agent polls the
REM cloud command queue and executes only hard-coded safe actions.
cd /d "%~dp0"
node "%~dp0gem-control-agent.cjs" --watch

echo.
echo Gem control agent stopped. Press any key to close this window.
pause >nul
