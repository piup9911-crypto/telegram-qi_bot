@echo off
cd /d "%~dp0"
node clean-telegram-thought-blocks.cjs --preview
pause
