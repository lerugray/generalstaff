#!/usr/bin/env bash
# GS heartbeat — Unix launcher (Linux / macOS)
#
# Starts the heartbeat supervisor in the current shell. The supervisor
# spawns claude in interactive mode with the Stop hook configured to
# bun src/heartbeat/hook.ts, watching io/inbox.jsonl for events.
#
# Run inside a tmux / screen session so the supervisor survives terminal
# disconnects.
#
# Usage:
#   ./scripts/heartbeat-run.sh                          # sonnet (default)
#   MODEL=opus ./scripts/heartbeat-run.sh               # opus
#   PROMPT="custom boot prompt" ./scripts/heartbeat-run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODEL="${MODEL:-sonnet}"
PROMPT="${PROMPT:-You are in GS heartbeat mode. Wait for inbox messages and act on them per CLAUDE.md.}"

export HEARTBEAT_IO_DIR="${HEARTBEAT_IO_DIR:-$REPO_ROOT/io}"
export HEARTBEAT_SETTINGS="$REPO_ROOT/scripts/heartbeat-settings.json"
export HEARTBEAT_SYSTEM_FILE="$REPO_ROOT/scripts/heartbeat-system-prompt.md"

echo "[GS-HEARTBEAT] starting from $REPO_ROOT"
echo "[GS-HEARTBEAT] model: $MODEL"
echo "[GS-HEARTBEAT] io dir: $HEARTBEAT_IO_DIR"
echo "[GS-HEARTBEAT] settings: $HEARTBEAT_SETTINGS"
echo "[GS-HEARTBEAT] system prompt file: $HEARTBEAT_SYSTEM_FILE"
echo

cd "$REPO_ROOT"
exec bun src/heartbeat/supervisor.ts "$MODEL" "$PROMPT"
