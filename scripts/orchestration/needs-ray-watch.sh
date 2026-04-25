#!/usr/bin/env bash
# needs-ray-watch.sh — emit one event line per child spawn that needs Ray.
#
# Designed for use with the Monitor harness primitive: tails for new
# `needs-ray.md` files appearing under ~/.claude/orchestration/spawns/*/.
# Each new file becomes one stdout line, which Monitor turns into one
# notification. Operator (Ray) gets a heads-up; primary session can then
# read the file's content and surface it.
#
# Also catches existing needs-ray.md files at startup (the "you missed
# this one" case after primary session resumed).
#
# Usage (from primary session, via Monitor tool):
#   Monitor(
#     description="needs-ray escalations from spawn children",
#     command="bash scripts/orchestration/needs-ray-watch.sh",
#     persistent=true
#   )

set -euo pipefail

ORCH_SPAWNS="${HOME}/.claude/orchestration/spawns"
mkdir -p "$ORCH_SPAWNS"

# State file: tracks which needs-ray.md files we've already emitted for.
# Per-monitor-run; reset each time the script restarts so existing files
# at startup get one emission.
SEEN_LOG="$(mktemp /tmp/needs-ray-seen.XXXXXX)"
trap 'rm -f "$SEEN_LOG"' EXIT

emit() {
  local spawn_id="$1"
  local nrf="$2"
  # One stdout line = one Monitor notification. Keep it short — full
  # content is in the file itself, primary will read it.
  local first_line
  first_line="$(head -n1 "$nrf" 2>/dev/null | head -c 180 || echo '(empty)')"
  echo "needs-ray spawn=${spawn_id}: ${first_line}"
}

# One-time: emit for any pre-existing needs-ray.md (catches stale escalations)
for nrf in "$ORCH_SPAWNS"/*/needs-ray.md; do
  [[ -f "$nrf" ]] || continue
  spawn_dir="$(dirname "$nrf")"
  spawn_id="$(basename "$spawn_dir")"
  echo "$nrf" >> "$SEEN_LOG"
  emit "$spawn_id" "$nrf"
done

# Poll loop — local FS, 2s interval. Cheap; no need for inotify.
while true; do
  for nrf in "$ORCH_SPAWNS"/*/needs-ray.md; do
    [[ -f "$nrf" ]] || continue
    if ! grep -Fxq "$nrf" "$SEEN_LOG" 2>/dev/null; then
      spawn_dir="$(dirname "$nrf")"
      spawn_id="$(basename "$spawn_dir")"
      echo "$nrf" >> "$SEEN_LOG"
      emit "$spawn_id" "$nrf"
    fi
  done
  sleep 2
done
