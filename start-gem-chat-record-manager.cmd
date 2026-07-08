@echo off
setlocal

set "ROOT=%~dp0"
rem 127.0.0.1 means only this computer can open it.
rem 0.0.0.0 means devices on the same Wi-Fi can open it through this PC's LAN IP.
set "GEM_CHAT_RECORD_MANAGER_HOST=0.0.0.0"
set "GEM_CHAT_RECORD_MANAGER_PORT=4144"

cd /d "%ROOT%"
echo Starting Gem bridge chat record manager...
echo PC browser:    http://127.0.0.1:4144
echo Phone browser: http://192.168.101.8:4144
node src\rp\gem-chat-record-manager.cjs
pause
