@echo off
setlocal

REM Optional convenience installer. It adds the Gem control agent to the current
REM Windows user's Startup folder so website buttons can work after login
REM without manually opening start-gem-control-agent.cmd each time.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$startup = [Environment]::GetFolderPath('Startup'); $target = Join-Path $startup 'Gem Control Agent.lnk'; $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut($target); $shortcut.TargetPath = '%~dp0start-gem-control-agent.cmd'; $shortcut.WorkingDirectory = '%~dp0'; $shortcut.WindowStyle = 7; $shortcut.Description = 'Polls cloud Gem control commands and starts local bridge scripts safely.'; $shortcut.Save(); Write-Host ('Installed startup shortcut: ' + $target)"

echo.
echo Press any key to close this window.
pause >nul
