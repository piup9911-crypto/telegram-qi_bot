@echo off
set "ROOT=%~dp0"
node "%ROOT%src\codex\codex-openai-bridge.cjs"
pause
