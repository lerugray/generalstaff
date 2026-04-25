#!/usr/bin/env bash
# orch-status.sh — single-shot orchestration health summary.
#
# Reads from:
#   - ~/.claude/orchestration/spawns/*/status.json   (per-spawn state)
#   - ~/.claude/orchestration/launches/*.json        (legacy bot launches)
#   - state/_fleet/PROGRESS.jsonl                    (bot fleet activity)
#   - tasklist                                       (active claude.exe processes)
#   - state/STOP                                     (operator stop file)
#
# Output is plain text optimized for primary-session readability. Cheap
# (no API calls, ~1s wall clock). Call any time the operator asks "how's
# orchestration doing."

set -euo pipefail

ORCH_ROOT="${HOME}/.claude/orchestration"
GS_ROOT="C:/Users/rweis/OneDrive/Documents/GeneralStaff"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date -u +%s; }

# Helper: convert ISO timestamp to epoch seconds
iso_to_epoch() {
  python3 -c "import datetime,sys; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "$1" 2>/dev/null || echo 0
}

NOW_EPOCH=$(now_epoch)

echo "=== orchestration status ($(now_iso)) ==="
echo ""

# --- Spawns -------------------------------------------------------------
echo "## active spawns"
SPAWN_DIR="${ORCH_ROOT}/spawns"
if [[ -d "$SPAWN_DIR" ]] && [[ -n "$(ls -A "$SPAWN_DIR" 2>/dev/null)" ]]; then
  for d in "$SPAWN_DIR"/*/; do
    [[ -d "$d" ]] || continue
    sid="$(basename "$d")"
    sf="${d}status.json"
    if [[ -f "$sf" ]]; then
      python3 - "$sf" "$NOW_EPOCH" <<'PYEOF' || echo "  ${sid}: (status.json unreadable)"
import json, sys, datetime
try:
    sf, now_epoch = sys.argv[1], int(sys.argv[2])
    d = json.load(open(sf))
    sid = d.get("spawn_id", "?")
    role = d.get("role", "?")
    state = d.get("state", "?")
    spawned = d.get("spawned_at", "")
    age_str = ""
    if spawned:
        try:
            sp_epoch = int(datetime.datetime.fromisoformat(spawned.replace("Z","+00:00")).timestamp())
            age_min = (now_epoch - sp_epoch) // 60
            age_str = f", age {age_min}m"
        except Exception:
            pass
    expected_end = d.get("expected_end")
    end_str = ""
    if expected_end:
        try:
            ee_epoch = int(datetime.datetime.fromisoformat(expected_end.replace("Z","+00:00")).timestamp())
            remain = (ee_epoch - now_epoch) // 60
            end_str = f", {remain}m to expected end" if remain > 0 else f", {-remain}m past expected end"
        except Exception:
            pass
    task = d.get("task", "")[:80]
    print(f"  {sid}: role={role} state={state}{age_str}{end_str}")
    if task:
        print(f"    task: {task}")
except Exception as e:
    print(f"  (parse error: {e})")
PYEOF
    else
      echo "  ${sid}: (no status.json)"
    fi
  done
else
  echo "  (no active spawns)"
fi
echo ""

# --- Legacy bot launches -----------------------------------------------
LAUNCHES="${ORCH_ROOT}/launches"
if [[ -d "$LAUNCHES" ]] && [[ -n "$(ls -A "$LAUNCHES" 2>/dev/null)" ]]; then
  echo "## bot launches"
  for f in "$LAUNCHES"/*.json; do
    [[ -f "$f" ]] || continue
    python3 - "$f" "$NOW_EPOCH" <<'PYEOF' || echo "  $(basename "$f"): (parse error)"
import json, sys, datetime
sf, now_epoch = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(sf))
    lid = d.get("spawn_id", d.get("launch_id", "?"))
    budget = d.get("budget_minutes", "?")
    expected = d.get("expected_end", "")
    if expected:
        try:
            ee_epoch = int(datetime.datetime.fromisoformat(expected.replace("Z","+00:00")).timestamp())
            remain = (ee_epoch - now_epoch) // 60
            status = f"{remain}m remaining" if remain > 0 else f"{-remain}m past expected end"
            print(f"  {lid}: budget {budget}min, {status}")
        except Exception:
            print(f"  {lid}: budget {budget}min")
    else:
        print(f"  {lid}: budget {budget}min")
except Exception as e:
    print(f"  (parse error: {e})")
PYEOF
  done
  echo ""
fi

# --- escalations -----------------------------------------------------
echo "## needs-ray escalations"
NEEDS_FOUND=0
for nrf in "$SPAWN_DIR"/*/needs-ray.md; do
  [[ -f "$nrf" ]] || continue
  spawn_id="$(basename "$(dirname "$nrf")")"
  echo "  ${spawn_id}: $(head -1 "$nrf" 2>/dev/null | head -c 200)"
  NEEDS_FOUND=$((NEEDS_FOUND+1))
done
[[ $NEEDS_FOUND -eq 0 ]] && echo "  (none)"
echo ""

# --- fleet activity ----------------------------------------------------
echo "## fleet (last 5 events)"
FP="${GS_ROOT}/state/_fleet/PROGRESS.jsonl"
if [[ -f "$FP" ]]; then
  tail -5 "$FP" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        ts = d.get('timestamp','?')[:19]
        ev = d.get('event','?')
        proj = d.get('project_id','?')
        data = d.get('data', {})
        if isinstance(data, dict):
            extra = ', '.join(f'{k}={v}' for k,v in data.items() if k in ('total_cycles','total_verified','total_failed','stop_reason','duration_minutes'))
            print(f'  {ts} {ev} {proj} {extra}')
        else:
            print(f'  {ts} {ev} {proj}')
    except Exception: pass
"
else
  echo "  (no fleet log)"
fi
echo ""

# --- recent cycle activity --------------------------------------------
echo "## recent cycles (last 30 min, any project)"
RECENT=$(find "${GS_ROOT}/state" -path "*/state/_*" -prune -o -type d -name "20*" -mmin -30 -print 2>/dev/null | head -8)
if [[ -n "$RECENT" ]]; then
  echo "$RECENT" | sed 's|.*state/||; s|^|  |'
else
  echo "  (no cycles in last 30 min)"
fi
echo ""

# --- claude.exe + bun.exe processes -----------------------------------
echo "## claude/bun processes"
if command -v tasklist &>/dev/null; then
  tasklist 2>/dev/null | grep -E "^(claude|bun|cmd)\.exe" | awk '{printf "  %-15s pid=%s mem=%sK\n", $1, $2, $5}' | head -10
else
  echo "  (tasklist unavailable)"
fi
echo ""

# --- stop file ---------------------------------------------------------
STOP_FILE="${GS_ROOT}/state/STOP"
if [[ -f "$STOP_FILE" ]]; then
  echo "## STOP file present"
  echo "  bot will halt at next cycle boundary"
else
  echo "## STOP file: absent"
fi
