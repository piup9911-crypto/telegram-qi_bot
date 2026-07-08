@echo off
cd /d "%~dp0"
node scripts\clean-telegram-thought-blocks.cjs --apply
pause
