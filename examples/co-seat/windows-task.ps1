# Register a Windows Task Scheduler task that runs the GeneralStaff co-seat watchdog every 5 minutes.
# Run once from a PowerShell prompt. Remove later with:
#   Unregister-ScheduledTask -TaskName 'GeneralStaff Co-seat Watchdog' -Confirm:$false
#
# Replace $Root with the folder that holds projects.yaml. generalstaff, bun and your agent CLI
# must be on that user's PATH. If your runners' `env` blocks name variables, set them as user
# environment variables (for example with setx) so the task can see them.

$Root = 'C:\path\to\GeneralStaff'
$SeatId = 'main'

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"generalstaff co-seat watchdog --id=$SeatId`"" `
    -WorkingDirectory $Root

# Start now, then repeat every 5 minutes.
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# The watchdog is idempotent and the driver takes a lock, so overlapping runs are harmless.
# StartWhenAvailable catches up after sleep. A zero time limit means "never stop this task",
# so the detached driver is not killed when the task's own time limit expires.
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances Parallel `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
    -TaskName 'GeneralStaff Co-seat Watchdog' `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Runs 'generalstaff co-seat watchdog --id=$SeatId' every 5 minutes." `
    -Force
