# enable-agent-teams.ps1 - one-time per-machine: opt into Claude Code Agent Teams.
#
# Adds CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to ~/.claude/settings.json so
# all future interactive Claude Code sessions on this machine can use the
# Agent Teams feature (https://code.claude.com/docs/en/agent-teams).
#
# Agent Teams is the official primitive for in-session parallel multi-agent
# work: a "lead" session can spawn 2-16 "teammates" with a shared task list
# and built-in inter-agent messaging. Documented constraints to be aware of:
#
#   - Lead is fixed for the team's lifetime; if the lead session ends,
#     teammates can't survive.
#   - In-process mode only on Windows (split-pane requires tmux/iTerm2).
#   - Each teammate is a full Claude Code instance - token costs scale.
#
# For "must survive my session" use cases (overnight bot launcher, etc.),
# use spawn-detached.ps1 instead - that's a different mechanism.
#
# Idempotent: safe to re-run; only modifies settings.json if the env var
# is missing.

$ErrorActionPreference = "Stop"

$settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"

if (-not (Test-Path $settingsPath)) {
    Write-Error "settings.json not found at $settingsPath. Initialize Claude Code first."
    exit 1
}

# Read settings.json
$settingsJson = Get-Content $settingsPath -Raw
$settings = $settingsJson | ConvertFrom-Json

# Ensure env block exists
if (-not $settings.PSObject.Properties['env']) {
    $settings | Add-Member -NotePropertyName 'env' -NotePropertyValue (New-Object PSObject)
}

if ($settings.env.PSObject.Properties['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']) {
    $current = $settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    if ($current -eq "1") {
        Write-Output "Agent Teams already enabled in $settingsPath (no change)."
        exit 0
    } else {
        $settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
        Write-Output "Updating CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS from '$current' to '1'."
    }
} else {
    $settings.env | Add-Member -NotePropertyName 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' -NotePropertyValue "1"
    Write-Output "Adding CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to $settingsPath."
}

# Backup before write
$backupPath = "${settingsPath}.backup-$(Get-Date -Format 'yyyyMMddTHHmmss')"
Copy-Item $settingsPath $backupPath
Write-Output "Backup written to: $backupPath"

# Write back
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding utf8

Write-Output ""
Write-Output "Done. Agent Teams will be available in NEW Claude Code sessions."
Write-Output "Existing sessions need to restart for the env var to take effect."
Write-Output ""
Write-Output "Usage in a new session: ask Claude to 'create an agent team' and"
Write-Output "describe the parallel work you want done. See docs:"
Write-Output "  https://code.claude.com/docs/en/agent-teams"
