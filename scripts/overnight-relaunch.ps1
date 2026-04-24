# overnight-relaunch.ps1 — sleep, then kick off scripts/run_session.bat.
#
# Intended for a chained overnight run: Stream A2 launched at 20:29
# with 240 min budget (expires ~00:29); this script sleeps until
# ~00:35 then launches Stream A3 with another 240 min budget.
#
# Usage (invoked via Start-Process at session-setup time):
#   powershell -File scripts/overnight-relaunch.ps1 -WaitMin 246 -Budget 240
#
# The wait + launch runs in a detached cmd window (visible per Ray's
# convention); OpenRouter env file + reviewer concurrency are
# plumbed through same as the interactive launch.

param(
    [int]$WaitMin = 246,
    [int]$Budget = 240
)

$start = Get-Date
Write-Output "overnight-relaunch: sleeping ${WaitMin} min from $($start.ToString('HH:mm'))"
Start-Sleep -Seconds ($WaitMin * 60)
$now = Get-Date
Write-Output "overnight-relaunch: waking at $($now.ToString('HH:mm')) — launching Stream A"

$env:OPENROUTER_ENV_FILE = "C:\Users\rweis\OneDrive\Documents\MiroShark\.env"
$env:GENERALSTAFF_REVIEWER_CONCURRENCY_OPENROUTER = "2"

Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c","scripts\run_session.bat","$Budget" `
    -WorkingDirectory "C:\Users\rweis\OneDrive\Documents\GeneralStaff" `
    -WindowStyle Normal

Write-Output "overnight-relaunch: kicked off run_session.bat $Budget min at $((Get-Date).ToString('HH:mm'))"
