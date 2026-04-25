#!/usr/bin/env bash
# spawn-tier2.sh — Tier 2 spawn primitive: backgrounded `claude -p` task.
#
# Spawns a one-shot headless claude run in the background, captures stdout
# to an outbox file, exits when the task completes. Lighter than Tier 3
# (no separate window, no interactive session) but heavier than the Agent
# subagent tool. Right tier when:
#   - You want a fresh context budget per task (Agent subagent shares mine)
#   - The task is bounded with a clear deliverable
#   - The work doesn't need to outlive the primary session
#
# Usage:
#   spawn-tier2.sh <spawn-id> <role-name> <prompt-file>
#
# The prompt-file is a markdown file with the full prompt for the task.
# Output is captured to ~/.claude/orchestration/spawns/<spawn-id>/outbox/result.md.
# Exit code recorded in status.json.

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <spawn-id> <role-name> <prompt-file>" >&2
  echo "" >&2
  echo "  <spawn-id>     Unique identifier (e.g. '20260424T220000_research')" >&2
  echo "  <role-name>    Role classifier (deep-dive | monitor | research | <custom>)" >&2
  echo "  <prompt-file>  Path to a markdown file with the full task prompt" >&2
  exit 64
fi

SPAWN_ID="$1"
ROLE_NAME="$2"
PROMPT_FILE="$3"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "ERROR: prompt file not found: $PROMPT_FILE" >&2
  exit 66
fi

ORCH_ROOT="${HOME}/.claude/orchestration"
SPAWN_DIR="${ORCH_ROOT}/spawns/${SPAWN_ID}"
OUTBOX="${SPAWN_DIR}/outbox"
STATUS_FILE="${SPAWN_DIR}/status.json"

mkdir -p "${SPAWN_DIR}/inbox" "${OUTBOX}" "${SPAWN_DIR}/log"

# Copy the prompt file into the spawn dir so the record is self-contained
cp "$PROMPT_FILE" "${SPAWN_DIR}/role.md"

# Initial status.json
SPAWNED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STATUS_FILE" <<EOF
{
  "spawn_id": "${SPAWN_ID}",
  "role": "${ROLE_NAME}",
  "tier": 2,
  "spawned_at": "${SPAWNED_AT}",
  "spawned_by": "spawn-tier2.sh",
  "state": "running",
  "prompt_file": "${PROMPT_FILE}",
  "outbox": "${OUTBOX}/result.md",
  "exit_code": null,
  "completed_at": null
}
EOF

# Run claude -p in the background, capture stdout + stderr to outbox
# Wrapper logs both stdout and exit code so the primary can read either later
RESULT_FILE="${OUTBOX}/result.md"
LOG_FILE="${SPAWN_DIR}/log/claude-p.log"

(
  # Run claude -p, capture output
  if claude -p "$(cat "$PROMPT_FILE")" > "$RESULT_FILE" 2> "$LOG_FILE"; then
    EXIT_CODE=0
    STATE="complete"
  else
    EXIT_CODE=$?
    STATE="failed"
  fi

  # Update status.json with completion
  COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - <<PYEOF || true
import json
with open("${STATUS_FILE}", "r") as f:
    d = json.load(f)
d["state"] = "${STATE}"
d["exit_code"] = ${EXIT_CODE}
d["completed_at"] = "${COMPLETED_AT}"
with open("${STATUS_FILE}", "w") as f:
    json.dump(d, f, indent=2)
PYEOF
) &

DETACHED_PID=$!
echo "Spawned tier-2 task: ${SPAWN_ID}"
echo "  PID: ${DETACHED_PID}"
echo "  Status: ${STATUS_FILE}"
echo "  Result will land at: ${RESULT_FILE}"
echo "  Log: ${LOG_FILE}"
echo ""
echo "SPAWN_ID=${SPAWN_ID}"
echo "PID=${DETACHED_PID}"
