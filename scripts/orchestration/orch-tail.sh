#!/usr/bin/env bash
# orch-tail.sh — tail a spawn's Claude Code session transcript.
#
# Tier 4 observability: lets the primary session see what a spawned
# interactive session is doing in near-real-time, without depending on
# the spawn writing to outbox/ or commits.
#
# Usage:
#   bash orch-tail.sh <spawn-id> [--lines N | --follow]
#
# Modes:
#   default     — print the last 50 events, formatted, then exit
#   --lines N   — print the last N events, formatted, then exit
#   --follow    — tail -f the transcript, formatting events as they arrive
#                 (use with Monitor for primary-session notifications)
#
# Mechanism: Claude Code writes per-session JSONL transcripts to
# ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl. The sanitization
# rule is: backslash and colon both become dash. We find the spawn's
# transcript by looking at status.json's cwd, sanitizing it, then picking
# the most-recent .jsonl in that dir created after the spawn started.

set -u

SPAWN_ID="${1:-}"
MODE="${2:-default}"
LINES="${3:-50}"

if [ -z "$SPAWN_ID" ]; then
    echo "Usage: $0 <spawn-id> [--lines N | --follow]" >&2
    echo "  --lines N — print last N events (default 50)" >&2
    echo "  --follow  — tail -f, format new events as they arrive" >&2
    exit 1
fi

ORCH_ROOT="$HOME/.claude/orchestration"
SPAWN_DIR="$ORCH_ROOT/spawns/$SPAWN_ID"

if [ ! -d "$SPAWN_DIR" ]; then
    # Maybe it was archived
    if [ -d "$ORCH_ROOT/completed/$SPAWN_ID" ]; then
        SPAWN_DIR="$ORCH_ROOT/completed/$SPAWN_ID"
    else
        echo "Spawn not found: $SPAWN_ID" >&2
        echo "Looked in: $ORCH_ROOT/spawns/ and $ORCH_ROOT/completed/" >&2
        exit 1
    fi
fi

STATUS="$SPAWN_DIR/status.json"
if [ ! -f "$STATUS" ]; then
    echo "No status.json in $SPAWN_DIR" >&2
    exit 1
fi

# Read cwd + spawned_at from status.json (use python — jq may not be on PATH).
read -r CWD SPAWNED_AT < <(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8-sig") as f:
    s = json.load(f)
print(s.get("cwd", ""), s.get("spawned_at", ""))
' "$STATUS")

if [ -z "$CWD" ]; then
    echo "status.json has no cwd field" >&2
    exit 1
fi

# Sanitize CWD the way Claude Code does: \ and : both become -.
SANITIZED=$(printf '%s' "$CWD" | sed -e 's|\\|-|g' -e 's|:|-|g' -e 's|/|-|g')
PROJECT_SESSIONS_DIR="$HOME/.claude/projects/$SANITIZED"

if [ ! -d "$PROJECT_SESSIONS_DIR" ]; then
    echo "No CC session dir found for spawn cwd:" >&2
    echo "  cwd: $CWD" >&2
    echo "  expected sessions at: $PROJECT_SESSIONS_DIR" >&2
    echo "(Spawn may not have started a session yet, or sanitization rule changed.)" >&2
    exit 1
fi

# Find the most-recent JSONL in the project sessions dir. Filter by mtime
# >= spawned_at so we don't pick up an earlier unrelated session.
TRANSCRIPT=$(find "$PROJECT_SESSIONS_DIR" -maxdepth 1 -name "*.jsonl" -newermt "$SPAWNED_AT" -type f 2>/dev/null | head -1)

if [ -z "$TRANSCRIPT" ]; then
    # Fallback: most recent regardless of mtime (spawn might still be
    # spinning up, or mtime granularity is off)
    TRANSCRIPT=$(ls -t "$PROJECT_SESSIONS_DIR"/*.jsonl 2>/dev/null | head -1)
fi

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
    echo "No transcript JSONL found in $PROJECT_SESSIONS_DIR" >&2
    exit 1
fi

# Formatter: read JSONL, emit a one-line summary per event.
# Events of interest:
#   {"type":"user", ...}        — user message (typed input)
#   {"type":"assistant", ...}   — model response (with tool uses inline)
#   {"type":"tool_use", ...}    — tool call (Read, Edit, Bash, etc.)
#   {"type":"tool_result", ...} — tool output
# JSONL lines vary in shape; be defensive.
FORMATTER='
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    t = e.get("type", "?")
    ts = e.get("timestamp", "")[:19].replace("T", " ")
    if t == "user":
        msg = e.get("message", {}).get("content", "")
        if isinstance(msg, list):
            msg = " ".join(str(x.get("text", x)) for x in msg if isinstance(x, dict))
        msg = str(msg)[:120].replace("\n", " ")
        print(f"{ts} USER: {msg}")
    elif t == "assistant":
        msg = e.get("message", {}).get("content", [])
        if isinstance(msg, list):
            for c in msg:
                if isinstance(c, dict):
                    if c.get("type") == "text":
                        text = str(c.get("text", ""))[:120].replace("\n", " ")
                        print(f"{ts} ASSISTANT: {text}")
                    elif c.get("type") == "tool_use":
                        name = c.get("name", "?")
                        inp = c.get("input", {})
                        if isinstance(inp, dict):
                            key_hint = inp.get("file_path") or inp.get("command") or inp.get("pattern") or ""
                            key_hint = str(key_hint)[:80]
                        else:
                            key_hint = ""
                        print(f"{ts} TOOL: {name}({key_hint})")
        else:
            text = str(msg)[:120].replace("\n", " ")
            print(f"{ts} ASSISTANT: {text}")
    elif t == "summary":
        s = str(e.get("summary", ""))[:120].replace("\n", " ")
        print(f"{ts} SUMMARY: {s}")
'

case "$MODE" in
    --follow)
        echo "# tailing $TRANSCRIPT (Ctrl+C to stop)" >&2
        tail -F -n 0 "$TRANSCRIPT" 2>/dev/null | python3 -c "$FORMATTER"
        ;;
    --lines)
        N="$LINES"
        echo "# transcript: $TRANSCRIPT (last $N events)" >&2
        tail -n "$N" "$TRANSCRIPT" | python3 -c "$FORMATTER"
        ;;
    *)
        echo "# transcript: $TRANSCRIPT (last 50 events)" >&2
        tail -n 50 "$TRANSCRIPT" | python3 -c "$FORMATTER"
        ;;
esac
