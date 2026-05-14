# GS Heartbeat Mode

Run GeneralStaff as a 24/7 reactive dispatcher driven by an inbox queue,
without paying for `claude -p` SDK credits.

> Status: experimental, landed 2026-05-14. Provides an event-driven outer
> layer that complements (and on 2026-06-15+, replaces) the scheduled-tasks
> + `claude -p` launcher pattern.

## What this is

`gs heartbeat` keeps a single Claude Code session alive in interactive
mode, watching a JSONL inbox for events. Each event becomes one fresh
session turn — the session reads the event, runs the requested action
(usually `generalstaff cycle <project>` or `generalstaff session`), writes
a JSON line to the outbox, then the supervisor restarts the session for
the next event with fresh context.

The trick: Claude Code's `Stop` hook can return
`{"decision": "block", "reason": "<text>"}`, which Anthropic's runtime
treats as an instruction to inject `reason` as the next user message
instead of letting the session end. The hook (see `src/heartbeat/hook.ts`)
uses this as a continuation primitive — idle ticks (~20 tokens) when the
inbox is empty, formatted message injections when work arrives.

## Why

### Cost (post-2026-06-15)

Anthropic separates `claude -p` and SDK billing into a dedicated credit
bucket on **2026-06-15**. Current GS scheduled-task launchers run
`claude -p` headlessly, which becomes a separately-billed line item
post-cliff. Heartbeat runs the outer launcher in interactive mode
against the Max subscription instead.

### 24/7 reactivity

Today GS runs on scheduled-task triggers (e.g. 0830 / 1230 / 1630).
Heartbeat lets external events drive dispatch — a Telegram inbound,
a webhook, a cron tick, or an operator typing
`bun scripts/heartbeat-inbox.ts run_cycle retrogaze` — and the session
reacts within seconds.

### Failure recovery

The supervisor handles crashes (auto-restart with 2s backoff), watchdog
stuck sessions (30 min default timeout), and orphaned processes (PID
file + reaper on startup).

## Quick start

```bash
# 1. Launch the supervisor (Windows)
.\scripts\heartbeat-run.ps1

# 1. Launch the supervisor (Linux/macOS)
./scripts/heartbeat-run.sh

# 2. From another shell — queue an action
bun scripts/heartbeat-inbox.ts status

# 3. Read the outbox
cat io/outbox.jsonl
```

The first launch creates the `io/` directory in the repo root. All
runtime state lives there and is gitignored.

## Action vocabulary

| Action | Argument | Behavior |
|---|---|---|
| `run_cycle` | `<project>` | One cycle on the named project (`generalstaff cycle <project>`) |
| `run_session` | `[--max-cycles=N]` | Picker mode (`generalstaff session --max-cycles=N`, default N=1) |
| `digest` | _none_ | Generate recent-activity digest |
| `status` | _none_ | Report fleet status |
| `manual` | `<free text>` | Agent handles content directly without dispatch wrapper |

Each action writes two outbox entries: `*_start` when invoked,
`*_complete` with `exit`, `summary`, and `duration_sec` when done.

## Architecture

```
external events (cron, webhook, telegram, operator)
    ↓ append a line
io/inbox.jsonl
    ↑ read by hook
src/heartbeat/hook.ts (Stop hook)
    ↑ fires after each agent turn
    │
    ▼
claude (interactive, --permission-mode auto)
    ↑ spawned + supervised by
src/heartbeat/supervisor.ts
    │
    ▼ via Bash tool
src/heartbeat/dispatch.ts (action handler)
    │
    ▼
generalstaff cycle / session / digest / status
    │
    ▼ writes
io/outbox.jsonl
    ↑ read by
optional relay (telegram, discord, webhook)
```

## File layout

```
src/heartbeat/
    supervisor.ts       # spawns + supervises claude, restart loop, watchdog
    hook.ts             # Stop hook — injects messages, signals restart
    dispatch.ts         # action → bun src/cli.ts <cmd> wrapper
    types.ts            # InboxMessage, OutboxMessage, HeartbeatAction

scripts/
    heartbeat-run.ps1                # Windows launcher
    heartbeat-run.sh                 # Unix launcher
    heartbeat-inbox.ts               # inbox injector CLI
    heartbeat-settings.json          # Stop hook config (--settings)
    heartbeat-system-prompt.md       # agent guidance (--append-system-prompt-file)

io/                                  # runtime state, gitignored
    inbox.jsonl                      # append-only event queue
    outbox.jsonl                     # append-only action results
    .last-tick                       # liveness timestamp
    .responded                       # transient flag: agent processed a msg
    .restart                         # transient flag: supervisor should restart child
    .inbox-offset                    # next byte to read from inbox.jsonl
    .supervisor.pid                  # supervisor process id
    .child.pid                       # current child (claude) process id
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HEARTBEAT_INTERVAL` | `60` | seconds between idle ticks |
| `WATCHDOG_TIMEOUT` | `1800` | seconds before supervisor kills a stuck session (covers 5-15 min cycles) |
| `HEARTBEAT_IO_DIR` | `<repo>/io` | override runtime directory |
| `HEARTBEAT_SETTINGS` | `<repo>/scripts/heartbeat-settings.json` | Stop hook config path |
| `HEARTBEAT_SYSTEM_FILE` | `<repo>/scripts/heartbeat-system-prompt.md` | appended system prompt |

## Coexistence with existing dispatch

Heartbeat is **additive**. Scheduled tasks (Windows Task Scheduler,
cron, launchd) keep working unchanged; they invoke
`scripts/scheduled-run-session.ps1` → `claude -p` exactly as today.

To migrate fully to heartbeat:
1. Confirm heartbeat handles your workload (single-machine + observable
   outbox is a good first deployment).
2. Disable the relevant scheduled tasks.
3. Replace them with cron entries that append to `io/inbox.jsonl`
   instead of launching claude directly. See
   `examples/heartbeat-cron-trigger.sh` (TODO).

To roll back: kill the supervisor (Ctrl+C the launcher console, or
`taskkill /PID $(cat io/.supervisor.pid)` on Windows). Scheduled tasks
resume on next tick. No state migration.

## Permission posture

The supervisor launches claude with `--permission-mode auto` (NOT
`--dangerously-skip-permissions`). Reasons:

- Workspace-trust prompts are bypassed by `auto` mode.
- Tool-permission decisions go through Claude's auto-classifier
  (gentler than the full bypass).
- The dispatcher target (`generalstaff cycle`) has its own safety net
  (hands-off list, reviewer gates, verification commands) — the outer
  heartbeat session is just an event router, not the engineer.

If you need the full bypass (sandbox without internet, etc.), edit
`src/heartbeat/supervisor.ts` directly; the bypass flag is intentionally
not exposed as an env override.

## ToS

The Stop-hook injection mechanism is a documented Claude Code feature
(`decision: "block"` with a `reason` field). Heartbeat uses the
documented contract; the unusual part is the use case (keep session alive
for automation), not the mechanism.

Anthropic may patch this behavior in a future Claude Code release if
they consider it an end-run on the `-p` billing carve-out. The
integration here stays thin — supervisor + hook + dispatcher are
~600 lines total — so a forced reversion to scheduled tasks is a
matter of disabling the launcher, not rewriting code. Don't bet
multiple weeks of architecture on the Stop-hook pattern surviving
long-term; do bet on it working through the 2026-06-15 cliff.

## Credit

Architectural pattern inspired by Siigari's [claude-heartbeat](
https://github.com/Siigari/claude-heartbeat) (MIT, 2026-05-13). The GS
implementation is a TypeScript port + GS-aware action dispatcher; the
load-bearing Stop-hook trick is theirs.
