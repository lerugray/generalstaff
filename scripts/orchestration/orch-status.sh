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
# Canonical state vocabulary (since v1 hardening 2026-04-25):
#   starting   - spawn just launched, hasn't taken first turn yet
#   active     - heartbeat fired at least once, currently working
#   complete   - terminal state, work done cleanly
#   failed     - terminal state, errored out
#   shutdown_requested - operator asked for graceful exit, spawn hasn't ack'd yet
# Legacy "completed" still recognized for spawns that landed before
# the canonical-state rule, but new spawns should produce "complete".
echo "## active spawns"
SPAWN_DIR="${ORCH_ROOT}/spawns"
if [[ -d "$SPAWN_DIR" ]] && [[ -n "$(ls -A "$SPAWN_DIR" 2>/dev/null)" ]]; then
  for d in "$SPAWN_DIR"/*/; do
    [[ -d "$d" ]] || continue
    sid="$(basename "$d")"
    sf="${d}status.json"
    if [[ ! -f "$sf" ]]; then
      echo "  ${sid}: (no status.json)"
      continue
    fi

    # Read core fields. Capture cmd_pid + project_path + spawned_at for the
    # lifecycle / discovery checks below.
    eval "$(python3 - "$sf" "$NOW_EPOCH" <<'PYEOF'
import json, sys, datetime, shlex
sf, now_epoch = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(sf, encoding="utf-8-sig"))
    sid = d.get("spawn_id", "?")
    role = d.get("role", "?")
    state = d.get("state", "?")
    spawned = d.get("spawned_at", "")
    cmd_pid = d.get("cmd_pid", "")
    project_path = d.get("project_path", "") or ""
    task = (d.get("task", "") or "")[:80]
    expected_end = d.get("expected_end", "") or ""
    last_hb = d.get("last_heartbeat", "") or ""
    age_min = ""
    if spawned:
        try:
            sp_epoch = int(datetime.datetime.fromisoformat(spawned.replace("Z","+00:00")).timestamp())
            age_min = str((now_epoch - sp_epoch) // 60)
        except Exception:
            pass
    hb_age_min = ""
    if last_hb:
        try:
            hb_epoch = int(datetime.datetime.fromisoformat(last_hb.replace("Z","+00:00")).timestamp())
            hb_age_min = str((now_epoch - hb_epoch) // 60)
        except Exception:
            pass
    end_remain = ""
    if expected_end:
        try:
            ee_epoch = int(datetime.datetime.fromisoformat(expected_end.replace("Z","+00:00")).timestamp())
            end_remain = str((ee_epoch - now_epoch) // 60)
        except Exception:
            pass
    # eval-friendly export
    print(f"_SID={shlex.quote(sid)}")
    print(f"_ROLE={shlex.quote(role)}")
    print(f"_STATE={shlex.quote(state)}")
    print(f"_SPAWNED={shlex.quote(spawned)}")
    print(f"_CMDPID={shlex.quote(str(cmd_pid))}")
    print(f"_PROJ={shlex.quote(project_path)}")
    print(f"_TASK={shlex.quote(task)}")
    print(f"_AGE={shlex.quote(age_min)}")
    print(f"_HBAGE={shlex.quote(hb_age_min)}")
    print(f"_ENDREM={shlex.quote(end_remain)}")
except Exception as e:
    print(f"_PARSE_ERR={shlex.quote(str(e))}")
PYEOF
)"

    if [[ -n "${_PARSE_ERR:-}" ]]; then
      echo "  ${sid}: (parse error: ${_PARSE_ERR})"
      continue
    fi

    # Lifecycle: combine status.json state with cmd_pid liveness
    PROC_STATE="?"
    if [[ -n "${_CMDPID}" && "${_CMDPID}" != "None" ]]; then
      if powershell -NoProfile -Command "[void](Get-Process -Id ${_CMDPID} -ErrorAction Stop)" 2>/dev/null; then
        PROC_STATE="alive"
      else
        PROC_STATE="dead"
      fi
    fi

    # Lifecycle inference: terminal states + alive cross-product
    case "${_STATE}" in
      complete|completed|failed|force_closed) terminal="yes" ;;
      *) terminal="no" ;;
    esac
    if [[ "$PROC_STATE" == "dead" && "$terminal" == "no" ]]; then
      LIFECYCLE="CRASHED (process dead, status not terminal)"
    elif [[ "$PROC_STATE" == "dead" && "$terminal" == "yes" ]]; then
      LIFECYCLE="terminated cleanly"
    elif [[ "$PROC_STATE" == "alive" && "$terminal" == "yes" ]]; then
      LIFECYCLE="zombie (status terminal but process still alive)"
    elif [[ "$PROC_STATE" == "alive" ]]; then
      LIFECYCLE="running"
    else
      LIFECYCLE="unknown (no cmd_pid)"
    fi

    age_str=""; [[ -n "${_AGE}" ]] && age_str=", age ${_AGE}m"
    end_str=""
    if [[ -n "${_ENDREM}" ]]; then
      if [[ "${_ENDREM}" -gt 0 ]]; then end_str=", ${_ENDREM}m to expected end"
      else end_str=", $((-_ENDREM))m past expected end"; fi
    fi
    hb_str=""; [[ -n "${_HBAGE}" ]] && hb_str=", hb ${_HBAGE}m ago"

    echo "  ${_SID}: role=${_ROLE} state=${_STATE} [${LIFECYCLE}]${age_str}${hb_str}${end_str}"
    [[ -n "${_TASK}" ]] && echo "    task: ${_TASK}"

    # Exit marker — independent process-completion signal
    EXIT_MARKER="${d}outbox/exit-marker.json"
    if [[ -f "$EXIT_MARKER" ]]; then
      EM_LINE=$(python3 -c "import json, sys; d=json.load(open(sys.argv[1], encoding='utf-8-sig')); print(f'exit_code={d.get(\"exit_code\",\"?\")}, exited_at={d.get(\"exited_at\",\"?\")}')" "$EXIT_MARKER" 2>/dev/null || echo "(unreadable)")
      echo "    exit-marker: ${EM_LINE}"
    fi

    # Notify flag — surfaced separately under needs-ray section below; just count here
    [[ -f "${d}notify-ray.flag" ]] && echo "    notify-ray.flag PRESENT (will trigger PushNotification)"

    # Discovery fallback: git log on project_path since spawned_at. Catches the
    # silent-success case where spawn shipped a commit but never updated status.
    if [[ -n "${_PROJ}" && -d "${_PROJ}/.git" && -n "${_SPAWNED}" ]]; then
      COMMITS=$(git -C "${_PROJ}" log --since="${_SPAWNED}" --oneline 2>/dev/null | head -3 || true)
      if [[ -n "$COMMITS" ]]; then
        echo "    commits in project since spawn:"
        echo "$COMMITS" | sed 's/^/      /'
      fi
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
    d = json.load(open(sf, encoding="utf-8-sig"))
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
