# GS heartbeat — PowerShell launcher (Windows)
#
# Starts the heartbeat supervisor in the current console. The supervisor
# spawns claude in interactive mode with the Stop hook configured to
# bun src/heartbeat/hook.ts, watching io/inbox.jsonl for events.
#
# Per Ray's "detached bot launches default to visible cmd windows" rule,
# launch this script from a dedicated cmd or PowerShell window so the
# supervisor's stdout is observable.
#
# Usage:
#   .\scripts\heartbeat-run.ps1                          # sonnet (default)
#   .\scripts\heartbeat-run.ps1 -Model opus              # opus
#   .\scripts\heartbeat-run.ps1 -Model sonnet -Prompt "Custom boot prompt"

param(
    [string]$Model = "sonnet",
    [string]$Prompt = "You are in GS heartbeat mode. Wait for inbox messages and act on them per CLAUDE.md.",
    [string]$IoDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if ($IoDir) {
    $env:HEARTBEAT_IO_DIR = $IoDir
} else {
    $env:HEARTBEAT_IO_DIR = Join-Path $RepoRoot "io"
}
$env:HEARTBEAT_SETTINGS = Join-Path $RepoRoot "scripts/heartbeat-settings.json"
$env:HEARTBEAT_SYSTEM_FILE = Join-Path $RepoRoot "scripts/heartbeat-system-prompt.md"

Write-Host "[GS-HEARTBEAT] starting from $RepoRoot"
Write-Host "[GS-HEARTBEAT] model: $Model"
Write-Host "[GS-HEARTBEAT] io dir: $($env:HEARTBEAT_IO_DIR)"
Write-Host "[GS-HEARTBEAT] settings: $($env:HEARTBEAT_SETTINGS)"
Write-Host "[GS-HEARTBEAT] system prompt file: $($env:HEARTBEAT_SYSTEM_FILE)"
Write-Host ""

Set-Location $RepoRoot
& bun src/heartbeat/supervisor.ts $Model $Prompt
