#!/usr/bin/env bash
# GS heartbeat — cron trigger example
#
# Append a `run_session` action to the heartbeat inbox on a schedule. The
# heartbeat supervisor's claude session picks it up on the next Stop-hook
# fire (within ~60s) and runs one cycle on the highest-priority project.
#
# Setup (cron):
#   0 8,12,16 * * * /path/to/generalstaff/examples/heartbeat-cron-trigger.sh
#
# Setup (Windows Task Scheduler):
#   Action: bun.exe
#   Args: C:\path\to\generalstaff\scripts\heartbeat-inbox.ts run_session
#   Trigger: daily at 08:00 / 12:00 / 16:00
#
# Compare with the existing scheduled-run-session.ps1 path which directly
# invokes claude -p — this version drops into the heartbeat session
# instead, so the dispatch billing stays on the Max subscription.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

cd "$REPO_ROOT"
exec bun scripts/heartbeat-inbox.ts run_session
