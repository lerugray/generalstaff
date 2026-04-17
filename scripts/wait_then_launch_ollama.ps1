# Polls a logs directory until the most recent session log has been idle
# for >IdleThresholdSeconds (no writes), then launches an Ollama dentist
# run via scripts\run_session.bat. Designed to be spawned detached via
# `Start-Process -WindowStyle Hidden`, so it survives the invoking claude
# or terminal window closing.
#
# Used once on 2026-04-17 to chain the dentist-window Ollama run after
# a currently-running 60-min OpenRouter session completed, while letting
# Ray close his interactive claude window before leaving for dentist.
#
# BUG HISTORY (gs-124): the first 2026-04-17 dentist-run attempt polled
# but never visibly fired the child Start-Process. Two contributing
# factors were identified:
#   1. No diagnostic output — when spawned detached/hidden, any stdout
#      from Start-Process was discarded, so a silent child-spawn failure
#      (bat missing, cmd.exe failing to start, etc.) left no evidence.
#   2. No -PassThru on Start-Process and no existence check on the bat,
#      so the script couldn't tell whether the child actually launched.
#
# The fix keeps the original behavior but:
#   - Parameterizes paths + thresholds so it's unit-testable
#   - Writes every iteration's decision to -DiagLog (when supplied) so
#     post-mortem is possible even in fully-detached invocations
#   - Uses an absolute path for the bat and checks existence before
#     calling Start-Process
#   - Uses -PassThru to confirm child PID
#   - Adds -DryRun so the smoke test can drive the launch path without
#     actually spawning a child session
#
# See tests/wait_then_launch_ollama.test.ts for the smoke test.

param(
  [string]$ProjectRoot = 'C:\Users\rweis\OneDrive\Documents\GeneralStaff',
  [string]$LogsDir = 'logs',
  [int]$IdleThresholdSeconds = 60,
  [int]$MaxWaitMinutes = 120,
  [int]$PollSeconds = 20,
  [string]$Budget = '90',
  [string]$Provider = 'ollama',
  [switch]$DryRun,
  [string]$DiagLog
)

$ErrorActionPreference = 'Continue'

function Write-Diag([string]$msg) {
  $ts = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'
  $line = "[$ts] $msg"
  Write-Output $line
  if ($DiagLog) {
    try { Add-Content -LiteralPath $DiagLog -Value $line -ErrorAction Stop } catch { }
  }
}

if (-not (Test-Path -LiteralPath $ProjectRoot)) {
  Write-Diag "ERROR: project root not found: $ProjectRoot"
  exit 2
}

Set-Location -LiteralPath $ProjectRoot

$logPattern = Join-Path $LogsDir 'session_*.log'
$batPath = Join-Path $ProjectRoot 'scripts\run_session.bat'
$startTime = Get-Date

Write-Diag "starting: root=$ProjectRoot logs=$logPattern idle=${IdleThresholdSeconds}s maxWait=${MaxWaitMinutes}m dryRun=$($DryRun.IsPresent)"

$shouldLaunch = $false
$launchReason = ''

while ($true) {
  $elapsed = (Get-Date) - $startTime
  if ($elapsed.TotalMinutes -gt $MaxWaitMinutes) {
    Write-Diag "giving up after $MaxWaitMinutes min (no idle window detected)"
    exit 1
  }

  $log = Get-ChildItem -Path $logPattern -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending |
         Select-Object -First 1

  if (-not $log) {
    $shouldLaunch = $true
    $launchReason = 'no session logs found'
    break
  }

  $idleSeconds = ((Get-Date) - $log.LastWriteTime).TotalSeconds
  Write-Diag ("polling: newest=$($log.Name) idle={0:N0}s threshold=${IdleThresholdSeconds}s" -f $idleSeconds)
  if ($idleSeconds -gt $IdleThresholdSeconds) {
    $shouldLaunch = $true
    $launchReason = ("log idle for {0:N0}s" -f $idleSeconds)
    break
  }

  Start-Sleep -Seconds $PollSeconds
}

Write-Diag "launch condition met: $launchReason"

if ($DryRun) {
  Write-Diag "dry-run: skipping Start-Process (would launch '$batPath $Budget $Provider')"
  exit 0
}

if (-not (Test-Path -LiteralPath $batPath)) {
  Write-Diag "ERROR: launcher bat not found at $batPath"
  exit 3
}

try {
  $proc = Start-Process -FilePath cmd.exe `
    -ArgumentList '/c', $batPath, $Budget, $Provider `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Minimized `
    -PassThru `
    -ErrorAction Stop
  Write-Diag "launched: pid=$($proc.Id) bat=$batPath budget=$Budget provider=$Provider"
  exit 0
} catch {
  Write-Diag "ERROR: Start-Process failed: $($_.Exception.Message)"
  exit 4
}
