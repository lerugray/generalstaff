#!/usr/bin/env bash
# inbox-inject.sh — Tier 4 spawn inbox polling hook.
#
# Wired into a spawn's settings.json as a UserPromptSubmit hook. Each time
# the user submits a turn in the spawn's cmd window, this hook checks the
# spawn's inbox/ for unread messages, returns their content as
# additionalContext (which Claude Code injects into the spawn's next turn),
# and moves the processed files to inbox/processed/.
#
# Effect: the primary session can drop messages into the spawn's inbox via
# orch-send.sh mid-conversation, and they reach the spawn on its next turn
# WITHOUT requiring the spawn to remember to check. Closes the "you can
# only send the initial message" gap that motivated Tier 4.
#
# Reads SPAWN_MAILBOX_DIR env var (set by spawn-detached.ps1 in the
# spawn-local settings.json env block). If unset, no-ops silently — same
# pattern as spawn-heartbeat.sh, so the hook is safe to ship in user-global
# settings without affecting non-spawn sessions.
#
# Output: prints a single JSON object on stdout per CC hook protocol:
#   {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
#                           "additionalContext": "..."}}
# If no unread inbox files, prints {} (no-op for the model).
#
# Implementation note: all file I/O and JSON construction happens in
# Python (with explicit UTF-8) to avoid bash-variable / printf encoding
# issues — round-tripping UTF-8 through Bash on Windows Git Bash mangles
# multi-byte chars like em-dashes (observed 2026-04-25 with cp1252 locale).

set -u

if [ -z "${SPAWN_MAILBOX_DIR:-}" ]; then
    echo '{}'
    exit 0
fi

PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python3 - "$SPAWN_MAILBOX_DIR" <<'PYEOF'
import json, os, sys
from pathlib import Path

mailbox = Path(sys.argv[1])
inbox = mailbox / "inbox"
if not inbox.is_dir():
    print("{}")
    sys.exit(0)

processed = inbox / "processed"
processed.mkdir(exist_ok=True)

# Top-level only, sort by name so 001-, 002-, ... arrive in order.
unread = sorted(
    [p for p in inbox.iterdir() if p.is_file() and p.suffix in (".md", ".txt")],
    key=lambda p: p.name,
)

if not unread:
    print("{}")
    sys.exit(0)

parts = [
    "--- INBOX MESSAGES FROM PRIMARY SESSION ---",
    "The following messages were dropped into your inbox by the orchestrating session",
    "while you were working. Treat them as additional user input for this turn:",
    "",
]

for p in unread:
    try:
        body = p.read_text(encoding="utf-8")
    except Exception as exc:
        body = f"[failed to read {p.name}: {exc}]"
    parts.append(f"### {p.name}")
    parts.append(body)
    parts.append("")

parts.append("--- END INBOX MESSAGES ---")
context = "\n".join(parts)

# Move processed files. Failures (file locked, race with another reader)
# are tolerated — better to inject the same message twice than to lose it.
for p in unread:
    try:
        p.rename(processed / p.name)
    except Exception:
        pass

out = {
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": context,
    }
}
print(json.dumps(out, ensure_ascii=False))
PYEOF
