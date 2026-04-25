# Role: bot-launcher

This role is a **wrapper-only spawn**, not a Claude Code session. The
spawn-detached.ps1 wrapper detects `RoleName=bot-launcher` and routes
to `scripts/run_session.bat <budget>` directly, skipping the claude
subprocess entirely.

There is no operational pattern for this role inside a Claude session
because no Claude session runs. The spawn metadata in
`~/.claude/orchestration/spawns/<id>/status.json` (and mirrored to
`~/.claude/orchestration/launches/<id>.json`) is the authoritative
record. Bot activity itself is tracked via:

- `state/_fleet/PROGRESS.jsonl` (fleet-level events)
- `state/<project>/PROGRESS.jsonl` (per-project events)
- `state/<project>/cycles/<cycle-id>/` (per-cycle artifacts)
- `logs/session_<ts>.log` (full launcher log per launch)

Use `scripts/orchestration/orch-status.sh` from the primary session to
get a snapshot.

## When to use this role

When the operator (or primary session) needs to launch the GS bot
session in a way that survives the primary session ending. Concrete
case: launching the overnight bot before the operator goes to bed,
or launching a focused N-minute catch-up run during the day.

## When NOT to use this role

- For one-off in-session bot interactions (use `bun src/cli.ts`
  directly).
- For scheduled bot launches — those go through `scheduled-run-session.ps1`
  via Task Scheduler. The orchestration layer reads their state but
  doesn't initiate them.
- When the primary session is already a bot session — that's a
  different recursion problem entirely.

## Stopping a bot-launcher spawn

`orch-kill.sh <spawn-id>` writes a shutdown signal but does NOT kill
the underlying `bun src/cli.ts session` process. The canonical clean
stop is to `touch state/STOP` at the GS root — the bot's session loop
checks for STOP between cycles and exits cleanly.

For emergency stops (e.g., bot is mid-cycle and going off the rails),
operator can `taskkill /pid <pid>` the bun.exe process directly. This
risks dirty state (partial commits, leftover worktree state) but is
sometimes the right move. The bot's anti-state-wipe gate (gs-318)
catches the most common corruption shape.
