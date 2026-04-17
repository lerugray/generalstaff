# Chain-launcher: waits for the most recent session log to contain
# "=== Session Complete ===" (the deterministic end-of-session marker
# written by session.ts), then spawns a new session with given args.
#
# Simpler and more reliable than the earlier wait_then_launch_ollama.ps1
# log-idle approach (which didn't fire as expected on 2026-04-17). Here
# we poll for a string that session.ts writes exactly once, at the end,
# after all cycles are done and the digest is written. No ambiguity
# about "is the log idle or just between cycles."
#
# Usage (detached):
#   powershell -Command "Start-Process -FilePath powershell.exe `
#     -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass', `
#       '-File','scripts\chain_next_session.ps1','-Budget','90','-Provider','ollama' `
#     -WorkingDirectory '...' -WindowStyle Hidden"

param(
  [string]$Budget = "90",
  [string]$Provider = "ollama",
  [int]$PollSeconds = 30
)

$ErrorActionPreference = 'Continue'
$projectRoot = 'C:\Users\rweis\OneDrive\Documents\GeneralStaff'
Set-Location $projectRoot

$maxMinutes = 180
$start = Get-Date

while (((Get-Date) - $start).TotalMinutes -lt $maxMinutes) {
  $log = Get-ChildItem 'logs\session_*.log' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending |
         Select-Object -First 1
  if ($log) {
    $content = Get-Content $log.FullName -Raw -ErrorAction SilentlyContinue
    if ($content -and $content.Contains('=== Session Complete ===')) {
      Start-Process -FilePath cmd.exe `
        -ArgumentList '/c', 'scripts\run_session.bat', $Budget, $Provider `
        -WorkingDirectory $projectRoot `
        -WindowStyle Minimized
      exit 0
    }
  }
  Start-Sleep -Seconds $PollSeconds
}

Write-Output "[chain_next_session] timed out after $maxMinutes min"
exit 1
