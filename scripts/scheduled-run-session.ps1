# scheduled-run-session.ps1 — wrapper invoked by Windows Task Scheduler.
#
# Sets the credential env vars that run_session.bat needs, then launches
# the bat synchronously. Stdout/stderr tee'd into logs/scheduled_<ts>.log
# so each scheduled run has a traceable artifact.
#
# Usage (via schtasks, not direct invocation):
#   schtasks /create /tn "GS-Stream-<name>" /sc ONCE /sd MM/DD/YYYY
#     /st HH:MM /tr "powershell -NoProfile -ExecutionPolicy Bypass
#     -File C:\Users\rweis\OneDrive\Documents\GeneralStaff\scripts\scheduled-run-session.ps1
#     -Budget 240"

param(
    [int]$Budget = 240
)

$env:OPENROUTER_ENV_FILE = "C:\Users\rweis\OneDrive\Documents\MiroShark\.env"
# Bumped to 3 for the 2026-04-24 blitz (matching max_parallel_slots=3
# in projects.yaml). If reviewer 429s happen frequently, drop back to 2.
$env:GENERALSTAFF_REVIEWER_CONCURRENCY_OPENROUTER = "3"

$gsRoot = "C:\Users\rweis\OneDrive\Documents\GeneralStaff"
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = Join-Path $gsRoot "logs\scheduled_$ts.log"

Write-Output "scheduled-run-session: $(Get-Date -Format 'HH:mm') budget=$Budget, log=$logFile"
Set-Location $gsRoot

# Pull latest code before launching so scheduled sessions pick up
# code fixes pushed from other machines without manual intervention.
# Fail-soft: if the pull errors (network down, merge conflict, detached
# HEAD), log and continue — stale code is preferred to a skipped
# session. Only the public repo; private-state sync still happens via
# sync-state.sh as normal.
try {
    $pullOut = & git pull --ff-only 2>&1 | Out-String
    Write-Output "scheduled-run-session: git pull — $($pullOut.Trim())"
} catch {
    Write-Output "scheduled-run-session: git pull failed ($($_.Exception.Message)), continuing with on-disk code"
}

# Run the .bat synchronously; schtasks Task will exit when the session does.
# Output teed so the scheduled log captures everything.
& cmd.exe /c "scripts\run_session.bat $Budget" *> $logFile
Write-Output "scheduled-run-session: exit $LASTEXITCODE at $(Get-Date -Format 'HH:mm')"
