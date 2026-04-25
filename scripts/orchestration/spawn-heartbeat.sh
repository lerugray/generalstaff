#!/usr/bin/env bash
# spawn-heartbeat.sh — auto-update status.json from a Claude Code Stop hook.
#
# Designed for use inside a spawned session via the spawn-local settings.json
# that spawn-detached.ps1 writes. Fires at the end of every LLM turn (Stop
# event), so heartbeat cadence == turn cadence.
#
# Path to status.json is passed via the SPAWN_STATUS_FILE env var, set by
# launch.bat. If unset (e.g. invoked outside a spawn), this script silently
# no-ops so it doesn't break a regular Claude Code session that happened to
# inherit the hook.
#
# Behavior on each fire:
#   - update last_heartbeat to current UTC time
#   - if state == "starting", transition to "active" (acknowledges the spawn
#     has taken at least one turn)
#   - leave state alone if already "active" / "complete" / "failed" / etc.
#
# Always exits 0 — a hook failure should not block the LLM from continuing.

set -uo pipefail

STATUS_FILE="${SPAWN_STATUS_FILE:-}"
[[ -z "$STATUS_FILE" ]] && exit 0
[[ ! -f "$STATUS_FILE" ]] && exit 0

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - <<PYEOF 2>/dev/null || true
import json
try:
    with open("${STATUS_FILE}", "r", encoding="utf-8") as f:
        d = json.load(f)
    d["last_heartbeat"] = "${NOW}"
    if d.get("state") == "starting":
        d["state"] = "active"
    with open("${STATUS_FILE}", "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
except Exception:
    pass
PYEOF

exit 0
