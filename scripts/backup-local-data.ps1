[CmdletBinding()]
param(
  [string]$BackupRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Naginoumi Backups\local-data'),
  [ValidateRange(2, 90)]
  [int]$RetentionCount = 14
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$documentsRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('MyDocuments')).TrimEnd('\')
$resolvedBackupRoot = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')

if (-not $resolvedBackupRoot.StartsWith("$documentsRoot\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "BackupRoot must stay inside Documents: $documentsRoot"
}

New-Item -ItemType Directory -Path $resolvedBackupRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archivePath = Join-Path $resolvedBackupRoot "naginoumi-local-data-$stamp.zip"
$stagingRoot = Join-Path $resolvedBackupRoot ".staging-$stamp-$([guid]::NewGuid().ToString('N'))"

$sources = @(
  @{ Path = 'memory-docs'; Required = $true; Mode = 'Tree' },
  @{ Path = 'bridge-state\chats'; Required = $true; Mode = 'JsonTree' },
  @{ Path = 'bridge-state\chat-archives'; Required = $false; Mode = 'JsonTree' },
  @{ Path = 'bridge-state\rp-chats'; Required = $false; Mode = 'JsonTree' },
  @{ Path = 'rp-config'; Required = $true },
  @{ Path = 'bridge-workspace\GEMINI.md'; Required = $true },
  @{ Path = 'bridge-workspace\CORE_MEMORY.md'; Required = $false },
  @{ Path = 'bridge-workspace-rp\GEMINI.md'; Required = $false },
  @{ Path = 'codex-bridge-state\chats'; Required = $false; Mode = 'JsonTree' },
  @{ Path = 'codex-bridge-state\tasks'; Required = $false; Mode = 'JsonTree' },
  @{ Path = 'codex-bridge-state\context-settings.json'; Required = $false },
  @{ Path = 'codex-bridge-state\project-aliases.json'; Required = $false }
)

$stateFiles = @(
  'context-settings.json',
  'gemini-disabled-sections.json',
  'lmc-cloud-sync-state.json',
  'lmc-provider-config-cache.json',
  'lmc-provider-status.json',
  'memory-ingest-state.json',
  'proactive-state.json',
  'shared-memory-cache.json',
  'small-summaries.json'
)

function Copy-SnapshotItem {
  param(
    [Parameter(Mandatory)] [string]$RelativePath,
    [Parameter(Mandatory)] [bool]$Required,
    [ValidateSet('Tree', 'JsonTree')] [string]$Mode = 'Tree'
  )

  $source = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    if ($Required) { throw "Required snapshot source is missing: $source" }
    return $false
  }

  $destination = Join-Path $stagingRoot $RelativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  if ($Mode -eq 'JsonTree' -and (Get-Item -LiteralPath $source).PSIsContainer) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse -Filter '*.json') {
      if ($file.Extension -ne '.json') { continue }
      $relativeFile = $file.FullName.Substring($source.Length).TrimStart('\')
      $destinationFile = Join-Path $destination $relativeFile
      New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFile) -Force | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $destinationFile -Force
    }
    return $true
  }

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
      return $true
    } catch {
      if ($attempt -eq 3) { throw }
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
}

$copied = [Collections.Generic.List[string]]::new()
try {
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

  foreach ($source in $sources) {
    $copyMode = if ($source.ContainsKey('Mode')) { $source.Mode } else { 'Tree' }
    if (Copy-SnapshotItem -RelativePath $source.Path -Required $source.Required -Mode $copyMode) {
      $copied.Add($source.Path)
    }
  }

  foreach ($name in $stateFiles) {
    $relativePath = "bridge-state\$name"
    if (Copy-SnapshotItem -RelativePath $relativePath -Required $false) {
      $copied.Add($relativePath)
    }
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    computer = $env:COMPUTERNAME
    repository = $repoRoot
    copied = @($copied)
    intentionallyExcluded = @(
      'secrets and *.env files',
      'logs, locks, pid files, temporary files, and old *.bak files',
      'rebuildable vector indexes',
      'experimental labs, Git metadata, node_modules, and downloaded media'
    )
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stagingRoot 'snapshot-manifest.json') -Encoding utf8

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingRoot,
    $archivePath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256

  $lastRun = [ordered]@{
    success = $true
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    archive = $archivePath
    bytes = (Get-Item -LiteralPath $archivePath).Length
    sha256 = $hash.Hash
    retainedCopies = $RetentionCount
  }
  $lastRun | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resolvedBackupRoot 'last-run.json') -Encoding utf8

  $oldArchives = Get-ChildItem -LiteralPath $resolvedBackupRoot -File -Filter 'naginoumi-local-data-*.zip' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $RetentionCount
  foreach ($oldArchive in $oldArchives) {
    if ([IO.Path]::GetDirectoryName($oldArchive.FullName).TrimEnd('\') -ne $resolvedBackupRoot) {
      throw "Refusing to remove an archive outside the verified backup root: $($oldArchive.FullName)"
    }
    Remove-Item -LiteralPath $oldArchive.FullName -Force
  }

  Write-Output (ConvertTo-Json $lastRun -Compress)
} finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    $verifiedStaging = [IO.Path]::GetFullPath($stagingRoot)
    if (-not $verifiedStaging.StartsWith("$resolvedBackupRoot\.staging-", [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove an unverified staging path: $verifiedStaging"
    }
    Remove-Item -LiteralPath $verifiedStaging -Recurse -Force
  }
}
