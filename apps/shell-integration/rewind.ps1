# REWIND — PowerShell hook.
#
# Records, for each command you run: the command line, its exit code, how long it took and the
# directory you ran it in. Never its output.
#
# Install:
#
#   Add-Content $PROFILE '. C:\path\to\rewind.ps1'
#
# PowerShell has no preexec/precmd pair, so this wraps `prompt` — the one function the shell calls
# after every command — and reads the last history entry. `Get-History` is where PowerShell already
# keeps the command line, its start time and its end time, so nothing has to be timed by hand and a
# multi-line or piped command arrives whole.
#
# Any existing `prompt` is kept and called: a hook that silently replaces someone's prompt is a hook
# that gets uninstalled the same evening.

if (Get-Variable -Name __RewindInstalled -Scope Global -ErrorAction SilentlyContinue) { return }
$global:__RewindInstalled = $true

$global:__RewindSpool = if ($env:REWIND_SPOOL) {
  $env:REWIND_SPOOL
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'REWIND\spool'
} else {
  Join-Path $HOME 'AppData\Local\REWIND\spool'
}

# The id of the last history entry already recorded, so pressing Enter on an empty line — or a
# prompt redraw — does not record the previous command a second time.
$global:__RewindLastId = -1

# Keep whatever prompt was already defined, including one installed by oh-my-posh or Starship.
$global:__RewindInnerPrompt = if (Test-Path function:prompt) { $function:prompt } else { $null }

function global:__RewindRecord {
  param([int]$Code)

  $entry = Get-History -Count 1 -ErrorAction SilentlyContinue
  if (-not $entry) { return }
  if ($entry.Id -le $global:__RewindLastId) { return }
  $global:__RewindLastId = $entry.Id
  if ([string]::IsNullOrWhiteSpace($entry.CommandLine)) { return }

  # Is anybody listening? A heartbeat older than two minutes means REWIND is not running, and a
  # command line does not go into a directory nothing reads.
  $beatFile = Join-Path $global:__RewindSpool '.alive'
  if (-not (Test-Path -LiteralPath $beatFile)) { return }
  $beat = 0L
  if (-not [int64]::TryParse((Get-Content -LiteralPath $beatFile -Raw -ErrorAction SilentlyContinue), [ref]$beat)) { return }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (($now - $beat) -ge 120000) { return }

  $started = if ($entry.StartExecutionTime) {
    [DateTimeOffset]::new($entry.StartExecutionTime.ToUniversalTime(), [TimeSpan]::Zero).ToUnixTimeMilliseconds()
  } else { $now }
  $ended = if ($entry.EndExecutionTime) {
    [DateTimeOffset]::new($entry.EndExecutionTime.ToUniversalTime(), [TimeSpan]::Zero).ToUnixTimeMilliseconds()
  } else { $now }

  $lines = @(
    'v=1'
    "ts=$started"
    "exit=$Code"
    "ms=$([Math]::Max(0, $ended - $started))"
    'shell=pwsh'
    "cwd=$($PWD.Path)"
    # Last, and the rest of the file: a command with quotes, newlines or '=' needs no escaping.
    "cmd=$($entry.CommandLine)"
  )

  $stem = Join-Path $global:__RewindSpool "$now-$PID-$(Get-Random)"
  try {
    # Written under a temporary name and moved into place, so REWIND never reads half a command.
    [IO.File]::WriteAllText("$stem.tmp", ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::Move("$stem.tmp", "$stem.cmd")
  } catch {
    # A spool that cannot be written is not worth an error in someone's prompt.
  }
}

function global:prompt {
  $ok = $?
  $code = if ($ok) { 0 } elseif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
  try { __RewindRecord -Code $code } catch { }

  if ($global:__RewindInnerPrompt) { & $global:__RewindInnerPrompt } else { "PS $($PWD.Path)> " }
}
