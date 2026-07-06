$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$state = Join-Path $root "st-bridge-state"
$bridgeScript = Join-Path $root "gemini-cli-openai-bridge.cjs"
$statusSyncScript = Join-Path $root "gem-status-sync.cjs"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$sshExe = "C:\Windows\System32\OpenSSH\ssh.exe"
$cloudflaredExe = Join-Path $root "cloudflared.exe"
$publicOut = Join-Path $state "localhostrun.out.log"
$publicErr = Join-Path $state "localhostrun.err.log"
$cloudflaredLog = Join-Path $state "cloudflared.out.log"
$publicUrlFile = Join-Path $state "public-openai-bridge-url.txt"
$statusSyncIntervalSeconds = 30

New-Item -ItemType Directory -Force -Path $state | Out-Null

function Get-Port4141Pid {
  # netstat is used instead of Get-NetTCPConnection because some Windows
  # installs restrict the CIM networking cmdlets even for admin-looking users.
  $line = netstat -ano | Select-String -Pattern "^\s*TCP\s+0\.0\.0\.0:4141\s+.*LISTENING\s+\d+" | Select-Object -First 1
  if (-not $line) {
    $line = netstat -ano | Select-String -Pattern "^\s*TCP\s+127\.0\.0\.1:4141\s+.*LISTENING\s+\d+" | Select-Object -First 1
  }
  if (-not $line) {
    return $null
  }
  $parts = ($line.Line.Trim() -split "\s+")
  return [int]$parts[-1]
}

Write-Host "Starting public Gemini CLI OpenAI bridge..." -ForegroundColor Cyan

$bridgePid = Get-Port4141Pid
if ($bridgePid) {
  Write-Host "Local bridge is already listening on port 4141. PID: $bridgePid"
} else {
  # The bridge must keep running locally; the HTTPS tunnel only forwards traffic
  # from phone/web clients back into this process.
  $bridge = Start-Process -FilePath $nodeExe -ArgumentList @($bridgeScript) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  $bridgePid = Get-Port4141Pid
  if (-not $bridgePid) {
    throw "The local bridge did not start. Check st-bridge-state\openai-bridge.log."
  }
  Write-Host "Local bridge started. PID: $bridgePid"
}

Remove-Item -LiteralPath $publicOut, $publicErr, $cloudflaredLog, $publicUrlFile -ErrorAction SilentlyContinue

function Find-PublicUrlFromLog($logPath) {
  if (-not (Test-Path $logPath)) {
    return $null
  }

  $text = Get-Content -Raw -Path $logPath
  $cloudflareMatch = [regex]::Match($text, "https://[A-Za-z0-9-]+\.trycloudflare\.com")
  if ($cloudflareMatch.Success) {
    return $cloudflareMatch.Value.TrimEnd(".", ",", ";")
  }

  $localhostRunMatch = [regex]::Match($text, "tunneled with tls termination,\s+(https://[A-Za-z0-9.-]+)")
  if ($localhostRunMatch.Success) {
    return $localhostRunMatch.Groups[1].Value.TrimEnd(".", ",", ";")
  }

  return $null
}

function Wait-PublicUrl($logPath, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $url = Find-PublicUrlFromLog $logPath
    if ($url) {
      return $url
    }
  }
  return $null
}

$tunnel = $null
$publicUrl = $null
$tunnelName = "localhost.run"

# Prefer cloudflared now that the correct Windows binary is installed. It gives
# browser/API clients a normal HTTPS endpoint and avoids the localhost.run
# connection drops we saw during remote-start testing.
if (Test-Path $cloudflaredExe) {
  $tunnelName = "Cloudflare Quick Tunnel"
  Write-Host "Starting Cloudflare Quick Tunnel for http://127.0.0.1:4141 ..."
  $tunnel = Start-Process `
    -FilePath $cloudflaredExe `
    -ArgumentList @("tunnel", "--url", "http://127.0.0.1:4141", "--logfile", $cloudflaredLog, "--loglevel", "info") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru
  Write-Host "Waiting for Cloudflare to assign an HTTPS URL..."
  $publicUrl = Wait-PublicUrl $cloudflaredLog 35
}

if (-not $publicUrl) {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }

  $tunnelName = "localhost.run"
  Write-Host "Falling back to localhost.run tunnel for http://127.0.0.1:4141 ..."
  # Anonymous localhost.run tunnels intentionally produce a new URL each time.
  # Keeping the raw logs plus a one-line URL file makes the latest address easy
  # to copy into mobile tools without searching terminal output.
  $tunnel = Start-Process `
    -FilePath $sshExe `
    -ArgumentList @("-o", "StrictHostKeyChecking=no", "-R", "80:127.0.0.1:4141", "nokey@localhost.run") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $publicOut `
    -RedirectStandardError $publicErr `
    -PassThru
  Write-Host "Waiting for localhost.run to assign an HTTPS URL..."
  $publicUrl = Wait-PublicUrl $publicOut 25
}

if (-not $publicUrl) {
  Write-Host "Tunnel PID: $($tunnel.Id)" -ForegroundColor Yellow
  Write-Host "No public URL was found yet. Check these logs:" -ForegroundColor Yellow
  Write-Host "  $publicOut"
  Write-Host "  $publicErr"
  exit 1
}

$baseUrl = "$publicUrl/v1"
Set-Content -Path $publicUrlFile -Value $baseUrl -Encoding UTF8

Write-Host ""
Write-Host "Use this in mini phone / SillyTavern:" -ForegroundColor Green
Write-Host "  Base URL: $baseUrl"
Write-Host "  API Key : sk-local-bridge"
Write-Host ""
Write-Host "Saved to:"
Write-Host "  $publicUrlFile"
Write-Host ""
Write-Host "Keep this window open while using the public URL." -ForegroundColor Yellow
Write-Host "Tunnel provider: $tunnelName"
Write-Host "Tunnel PID: $($tunnel.Id)"

try {
  Set-Clipboard -Value $baseUrl
  Write-Host "The Base URL has also been copied to clipboard."
} catch {
  Write-Host "Clipboard copy failed, but the URL file above was written."
}

# The website status page cannot read this PC directly, so this launcher keeps
# sending a compact heartbeat to /api/gem-status while the public tunnel lives.
# A stale timestamp on the web page is therefore a useful clue that this window,
# the tunnel, or the local bridge has stopped.
Write-Host ""
Write-Host "Syncing Gem status to the website every $statusSyncIntervalSeconds seconds..." -ForegroundColor Cyan
while (-not $tunnel.HasExited) {
  try {
    & $nodeExe $statusSyncScript
  } catch {
    Write-Host "Status sync failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  Start-Sleep -Seconds $statusSyncIntervalSeconds
  $tunnel.Refresh()
}

Write-Host "Tunnel process exited."
