#!/usr/bin/env bash
# orch-list.sh — terse list of active spawn IDs (one per line, parseable).
#
# Output format:
#   <spawn_id>\t<role>\t<state>\t<age_minutes>
#
# Useful for scripting, looping, parsing in primary session. For
# human-readable summary use orch-status.sh instead.

set -euo pipefail

ORCH_ROOT="${HOME}/.claude/orchestration"
SPAWN_DIR="${ORCH_ROOT}/spawns"
NOW_EPOCH=$(date -u +%s)

if [[ ! -d "$SPAWN_DIR" ]]; then
  exit 0
fi

for d in "$SPAWN_DIR"/*/; do
  [[ -d "$d" ]] || continue
  sid="$(basename "$d")"
  sf="${d}status.json"
  if [[ -f "$sf" ]]; then
    python3 - "$sf" "$NOW_EPOCH" "$sid" <<'PYEOF' || echo -e "${sid}\t?\t?\t?"
import json, sys, datetime
sf, now_epoch, sid = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    d = json.load(open(sf))
    role = d.get("role", "?")
    state = d.get("state", "?")
    spawned = d.get("spawned_at", "")
    age_min = "?"
    if spawned:
        try:
            sp_epoch = int(datetime.datetime.fromisoformat(spawned.replace("Z","+00:00")).timestamp())
            age_min = str((now_epoch - sp_epoch) // 60)
        except Exception:
            pass
    print(f"{sid}\t{role}\t{state}\t{age_min}")
except Exception:
    print(f"{sid}\t?\t?\t?")
PYEOF
  else
    echo -e "${sid}\t?\tno-status\t?"
  fi
done
