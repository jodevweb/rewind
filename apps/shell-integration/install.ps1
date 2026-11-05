# Install the REWIND shell hook into your PowerShell profile.
#
#   pwsh -File apps/shell-integration/install.ps1
#
# Idempotent: running it twice changes nothing. It appends one dot-source line to $PROFILE and says
# what it did. Uninstalling is deleting that line.

$ErrorActionPreference = 'Stop'

$hook = Join-Path $PSScriptRoot 'rewind.ps1'
$line = ". `"$hook`""

$dir = Split-Path -Parent $PROFILE
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

if ((Test-Path -LiteralPath $PROFILE) -and (Select-String -LiteralPath $PROFILE -SimpleMatch $hook -Quiet)) {
  Write-Host "REWIND: already installed in $PROFILE"
  return
}

Add-Content -LiteralPath $PROFILE -Encoding utf8 -Value @"

# REWIND — terminal events (commands and exit codes, never their output).
$line
"@

Write-Host "REWIND: added to $PROFILE"
Write-Host "Open a new terminal, or run: $line"
