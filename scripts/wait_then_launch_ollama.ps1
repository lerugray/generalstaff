# Polls the most recent session log file until it's been idle for >60
# seconds (no writes), then launches a 90-min Ollama dentist run. Spawned
# detached from the invoking claude-code session via `Start-Process
# -WindowStyle Hidden`, so it survives the interactive window closing.
#
# Used once on 2026-04-17 to chain the dentist-window Ollama run after
# a currently-running 60-min OpenRouter session completed, while letting
# Ray close his interactive claude window before leaving for dentist.
#
# One-shot: exits after the launch fires. Safe to re-run manually as
# long as no session is currently running.

$ErrorActionPreference = 'Continue'
$projectRoot = 'C:\Users\rweis\OneDrive\Documents\GeneralStaff'
Set-Location $projectRoot

$maxWaitMinutes = 120  # hard ceiling — if current session somehow
                       # runs 2+ hours over budget, give up rather than
                       # poll forever
$startTime = Get-Date
$idleThresholdSeconds = 60

while ($true) {
  $elapsed = (Get-Date) - $startTime
  if ($elapsed.TotalMinutes -gt $maxWaitMinutes) {
    Write-Output "[wait_then_launch_ollama] giving up after $maxWaitMinutes min"
    exit 1
  }

  $log = Get-ChildItem 'logs\session_*.log' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending |
         Select-Object -First 1

  if (-not $log) {
    Write-Output "[wait_then_launch_ollama] no session logs found — launching now"
    break
  }

  $idleSeconds = ((Get-Date) - $log.LastWriteTime).TotalSeconds
  if ($idleSeconds -gt $idleThresholdSeconds) {
    Write-Output "[wait_then_launch_ollama] log idle for $([int]$idleSeconds)s — launching Ollama run"
    break
  }

  Start-Sleep -Seconds 20
}

Start-Process -FilePath cmd.exe `
  -ArgumentList '/c', 'scripts\run_session.bat', '90', 'ollama' `
  -WorkingDirectory $projectRoot `
  -WindowStyle Minimized
