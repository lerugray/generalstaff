#!/usr/bin/env bash
# orch-send.sh — append a message to a spawn's inbox.
#
# Writes a numbered file under ~/.claude/orchestration/spawns/<id>/inbox/.
# The spawn is responsible for reading its inbox on each turn (per the
# role.md operational pattern).
#
# Usage:
#   orch-send.sh <spawn-id> <message-file>
#   orch-send.sh <spawn-id> -                   # read from stdin
#
# Numbering: NNN-<basename-of-source>.md (e.g., 003-task-update.md).
# Numbers are zero-padded sequence per spawn, monotonic.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <spawn-id> <message-file|->" >&2
  exit 64
fi

SPAWN_ID="$1"
SRC="$2"

ORCH_ROOT="${HOME}/.claude/orchestration"
INBOX="${ORCH_ROOT}/spawns/${SPAWN_ID}/inbox"

if [[ ! -d "$INBOX" ]]; then
  echo "ERROR: spawn inbox not found: $INBOX" >&2
  echo "       (use orch-list.sh to see valid spawn IDs)" >&2
  exit 66
fi

# Determine next sequence number
LAST_NUM=$(ls "$INBOX"/[0-9]*.md 2>/dev/null | sed 's|.*/||; s|^\([0-9]*\)-.*|\1|; s|^0*||' | sort -n | tail -1 || echo 0)
LAST_NUM=${LAST_NUM:-0}
NEXT_NUM=$((LAST_NUM + 1))
PADDED=$(printf "%03d" "$NEXT_NUM")

if [[ "$SRC" == "-" ]]; then
  # Read from stdin
  TARGET="${INBOX}/${PADDED}-stdin.md"
  cat > "$TARGET"
else
  if [[ ! -f "$SRC" ]]; then
    echo "ERROR: message file not found: $SRC" >&2
    exit 66
  fi
  BASENAME="$(basename "$SRC" .md)"
  TARGET="${INBOX}/${PADDED}-${BASENAME}.md"
  cp "$SRC" "$TARGET"
fi

echo "Sent to ${SPAWN_ID}: ${TARGET}"
