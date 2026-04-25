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
d = json.load(open(sf, encoding="utf-8-sig"))
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
  CMD_PID=$(python3 -c "import json; print(json.load(open('${STATUS_FILE}', encoding='utf-8-sig')).get('cmd_pid', ''))" 2>/dev/null || echo "")
  if [[ -z "$CMD_PID" || "$CMD_PID" == "None" ]]; then
    echo "ERROR: status.json has no cmd_pid (spawn pre-dates v1 hardening?)"
    echo "       Manual: tasklist /fi 'imagename eq cmd.exe' to find the cmd window,"
    echo "       then taskkill /pid <pid>. For bot sessions, prefer:"
    echo "       touch state/STOP (clean stop at next cycle boundary)."
    exit 1
  fi
  echo "Force-closing cmd window PID=$CMD_PID for spawn ${SPAWN_ID}..."
  if powershell -NoProfile -Command "Stop-Process -Id $CMD_PID -Force -ErrorAction Stop" 2>/dev/null; then
    echo "  cmd PID $CMD_PID terminated."
    python3 - "$STATUS_FILE" <<'PYEOF'
import json, sys, datetime
sf = sys.argv[1]
d = json.load(open(sf, encoding="utf-8-sig"))
d["state"] = "force_closed"
d["force_closed_at"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
with open(sf, "w") as f:
    json.dump(d, f, indent=2)
PYEOF
    echo "  status.json state -> force_closed"
  else
    echo "  WARNING: Stop-Process failed (process may already be gone)"
  fi
  echo ""
  echo "Note: --force-process kills the cmd parent. For bot-launcher spawns,"
  echo "the proper clean stop is: touch state/STOP (graceful at cycle boundary)."
fi
