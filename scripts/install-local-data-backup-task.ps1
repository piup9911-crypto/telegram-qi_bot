[CmdletBinding()]
param(
  [string]$TaskName = 'Naginoumi Local Data Snapshot',
  [datetime]$DailyAt = ((Get-Date).Date.AddHours(3).AddMinutes(15))
)

$ErrorActionPreference = 'Stop'
$backupScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'backup-local-data.ps1'))
if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
  throw "Backup script not found: $backupScript"
}

$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Daily rotating snapshot of Naginoumi local chats, LMC memory, and RP configuration.' `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
