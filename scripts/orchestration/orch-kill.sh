#!/usr/bin/env bash
# orch-kill.sh — write a graceful-shutdown signal to a spawn.
#
# Writes a high-priority shutdown.md file to the spawn's inbox AND sets
# state="shutdown_requested" in status.json. The spawn is expected to
# notice on its next turn and exit cleanly.
#
# Does NOT kill the OS process directly — that's a separate concern,
# left to the operator since killing claude.exe mid-cycle can leave
# partial commits / dirty state. For the bot launcher specifically,
# the canonical stop is to touch state/STOP at the GS root.
#
# Usage:
#   orch-kill.sh <spawn-id>
#   orch-kill.sh <spawn-id> --force-process    # also kill claude.exe (use sparingly)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <spawn-id> [--force-process]" >&2
  exit 64
fi

SPAWN_ID="$1"
FORCE_PROCESS="${2:-}"

ORCH_ROOT="${HOME}/.claude/orchestration"
SPAWN_DIR="${ORCH_ROOT}/spawns/${SPAWN_ID}"
INBOX="${SPAWN_DIR}/inbox"
STATUS_FILE="${SPAWN_DIR}/status.json"

if [[ ! -d "$SPAWN_DIR" ]]; then
  echo "ERROR: spawn dir not found: $SPAWN_DIR" >&2
  exit 66
fi

# Write shutdown message to inbox
mkdir -p "$INBOX"
cat > "${INBOX}/000-shutdown.md" <<EOF
# SHUTDOWN REQUESTED

The orchestration layer has requested a graceful shutdown of this spawn.

Please:
1. Finish your current operation if it's nearly done.
2. Write a final status entry to outbox/ summarizing what was accomplished.
3. Set status.json state to "shutdown_complete".
4. Exit the session.

Do NOT start any new long-running operations.
EOF

# Update status.json
if [[ -f "$STATUS_FILE" ]]; then
  python3 - "$STATUS_FILE" <<'PYEOF'
import json, sys, datetime
sf = sys.argv[1]
d = json.load(open(sf))
d["state"] = "shutdown_requested"
d["shutdown_requested_at"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
with open(sf, "w") as f:
    json.dump(d, f, indent=2)
PYEOF
  echo "Shutdown signaled: ${SPAWN_ID}"
else
  echo "WARNING: no status.json to update for ${SPAWN_ID}"
fi

if [[ "$FORCE_PROCESS" == "--force-process" ]]; then
  echo ""
  echo "WARNING: --force-process not implemented (would risk dirty state)."
  echo "         To kill claude.exe manually: tasklist /fi 'imagename eq claude.exe'"
  echo "         then taskkill /pid <pid>. For bot sessions, prefer:"
  echo "         touch state/STOP (clean stop at next cycle boundary)."
fi
