# scripts/orchestration

Inter-session orchestration for the GeneralStaff workflow. Lets a
primary Claude Code session drive other Claude Code sessions / bot
launches without the operator having to manage multiple terminal
windows manually.

Designed for the "single Claude session was wearing too many hats"
failure shape (see `docs/sessions/2026-04-24-home-pc-evening-addendum.md`
+ `docs/internal/SESSION-ORCHESTRATION-2026-04-24.md` in the private
companion repo). The orchestration layer routes long-running
side-quests to dedicated sessions so the primary doesn't carry
launcher / monitor / project-deep work in its own context.

## When to use what tier

The primary session has four parallel-work primitives, in order of
weight:

| Tier | Primitive | When |
|------|-----------|------|
| 0 | `Agent` subagent (in-process) | Parallel research / review you want results from now |
| 0.5 | Agent Teams (in-process, opt-in) | Coordinated parallel work needing inter-agent messaging — see `enable-agent-teams.ps1` |
| 1 | `claude -p` background (`spawn-tier2.sh`) | Bounded one-shot side-quest with fresh context; ~1-5 min |
| 2 | Detached cmd (`spawn-detached.ps1`) | Long-running side-quest that must outlive primary session |

**Discipline:** always pick the lightest tier that solves the problem.
Tier 2 only when the work genuinely needs to outlive the primary
session.

## File layout

```
scripts/orchestration/
├── README.md                           # this file
├── enable-agent-teams.ps1              # one-time per-machine: opt into Agent Teams
├── spawn-detached.ps1                  # Tier 3 spawn (detached cmd, survives primary)
├── spawn-tier2.sh                      # Tier 2 spawn (background claude -p)
├── spawn-heartbeat.sh                  # Stop-hook script: auto-updates status.json
├── orch-status.sh                      # snapshot: spawns + launches + fleet + lifecycle + git-discovery
├── orch-list.sh                        # parseable: <id>\t<role>\t<state>\t<age>
├── orch-send.sh                        # append message to spawn's inbox
├── orch-kill.sh                        # graceful inbox shutdown OR --force-process via cmd_pid
├── needs-ray-watch.sh                  # for the Monitor harness primitive
└── roles/
    ├── bot-launcher.md                 # wrapper-only role (runs run_session.bat)
    ├── deep-dive.md                    # focused project work session
    └── monitor.md                      # ambient observability watcher
```

## State schema (v1, 2026-04-25)

`status.json` canonical fields:

| Field | Set by | Purpose |
|-------|--------|---------|
| `spawn_id` | spawn wrapper | unique per spawn |
| `role` | spawn wrapper | role classifier |
| `state` | spawn → hook → LLM | lifecycle (see below) |
| `spawned_at` | spawn wrapper | ISO UTC |
| `last_heartbeat` | heartbeat Stop hook | ISO UTC, advances per LLM turn |
| `cmd_pid` | spawn wrapper | parent cmd window PID for liveness check |
| `launch_bat` | spawn wrapper | path to the per-spawn launch.bat |
| `notify_on_exit` | spawn wrapper (-NotifyOnExit) | bool, writes notify-ray.flag on exit |
| `project_path` | spawn wrapper (-ProjectPath) | enables git-log discovery in orch-status |
| `task` | spawn wrapper (-Task) | one-line description |
| `expected_end` | spawn wrapper (bot-launcher) | ISO UTC, for budget tracking |

Canonical state vocabulary:

- `starting` — spawn just launched, hasn't taken first turn yet
- `active` — heartbeat hook fired at least once, currently working
- `complete` — terminal, work done cleanly (LLM-set OR heartbeat-detected)
- `failed` — terminal, errored out
- `force_closed` — terminal, operator killed via orch-kill --force-process
- `shutdown_requested` — operator asked for graceful exit, spawn hasn't ack'd yet

Legacy `completed` is recognized as a synonym for `complete` (transition compat).

## Independent completion signals (v1 hardening)

The orchestration NO LONGER trusts the LLM-written `status.json` alone. Three
independent signals get aggregated by `orch-status.sh`:

1. **status.json `state`** — what the LLM thinks. Subject to "LLM forgot to
   update it" failure mode.
2. **cmd_pid liveness** — `Get-Process -Id <cmd_pid>` returns alive/dead.
   Independent of LLM behavior. Distinguishes:
   - `running` (PID alive + non-terminal state)
   - `terminated cleanly` (PID dead + terminal state)
   - `CRASHED` (PID dead + non-terminal state — flagged in output)
   - `zombie` (PID alive + terminal state — flagged in output)
3. **outbox/exit-marker.json** — written by launch.bat AFTER claude exits.
   Captures cmd exit code + timestamp. Independent of LLM behavior.
4. **git-log discovery** — orch-status runs `git -C <project_path>
   log --since=<spawned_at>` and surfaces commits made by the spawn. Catches
   the silent-success case where the spawn shipped a commit but never wrote
   `outbox/result.md` or updated `status.json`.

Concretely: even if a spawn forgets every reporting convention in role.md,
the orchestration layer still knows it shipped, when it shipped, and what
commits it produced.

## Heartbeat hook

Each Tier 3 spawn gets a spawn-local `settings.json` (in its mailbox dir)
with a Stop hook that runs `spawn-heartbeat.sh`. The hook updates
`status.json`'s `last_heartbeat` field on every LLM turn and transitions
`starting` → `active` on the first fire. `--settings <path>` is passed to
the claude command in launch.bat.

The hook reads the status.json path from `SPAWN_STATUS_FILE` env var (also
set in spawn-local settings.json's `env` block). If unset (e.g. invoked
outside a spawn), the hook silently no-ops.

Lean-ctx and other user-global hooks continue to fire in spawned sessions
because Claude Code merges --settings additively with user settings.

## State directory (per-machine)

Runtime state lives under `~/.claude/orchestration/`:

```
~/.claude/orchestration/
├── spawns/
│   └── <spawn-id>/
│       ├── role.md          # operational context written at spawn time
│       ├── status.json      # heartbeat, state, task
│       ├── inbox/           # numbered messages TO this spawn
│       │   └── 001-task.md
│       ├── outbox/          # outputs FROM this spawn
│       │   └── result.md
│       ├── needs-ray.md     # ESCALATION marker (if present, surface to Ray)
│       └── log/             # debug logs
├── launches/                # legacy bot-launcher metadata mirror
│   └── <launch-id>.json
└── completed/               # archived completed spawns
```

This dir is per-machine (matches Claude Code's `~/.claude` convention).
No cross-machine sync — each machine orchestrates its own children.

## Common operations (from primary session)

### Launch the overnight bot

```bash
powershell -ExecutionPolicy Bypass -File scripts/orchestration/spawn-detached.ps1 \
  -RoleName bot-launcher -BudgetMinutes 600
```

Returns a spawn ID. The bot launches in a detached cmd window;
metadata lands in `~/.claude/orchestration/launches/`. Survives
primary session death.

### Spawn a project deep-dive

```bash
powershell -ExecutionPolicy Bypass -File scripts/orchestration/spawn-detached.ps1 \
  -RoleName deep-dive \
  -ProjectPath "C:\path\to\retrogaze" \
  -Task "Investigate fantasy-bias rg-013 — propose fixes, don't ship" \
  -Brief
```

`-Brief` enables the spawned session's `SendUserMessage` tool so it
can surface heads-ups directly to Ray.

### Check orchestration health

```bash
bash scripts/orchestration/orch-status.sh
```

Single-shot summary: active spawns, launches, fleet activity, recent
cycles, claude/bun processes, STOP file status. Cheap, no API calls.

### Watch for escalations (long-running)

From the primary session, register a `Monitor`:

```
Monitor(
  description="needs-ray escalations from spawn children",
  command="bash scripts/orchestration/needs-ray-watch.sh",
  persistent=true
)
```

Each new `needs-ray.md` becomes one notification.

### Send a task update to a running spawn

```bash
bash scripts/orchestration/orch-send.sh <spawn-id> ./task-update.md
# or read from stdin:
echo "Update: focus on X first" | bash scripts/orchestration/orch-send.sh <spawn-id> -
```

### Stop a spawn gracefully

```bash
bash scripts/orchestration/orch-kill.sh <spawn-id>
```

Writes a shutdown.md to the spawn's inbox; spawn exits cleanly on
next turn. For the bot launcher specifically, `touch state/STOP` is
the canonical clean stop instead.

## Constraints + non-goals

- **Windows-native.** All scripts assume Windows + Git Bash + the
  same PATH setup as `scripts/run_session.bat`.
- **No cross-machine.** Each machine's primary orchestrates its own
  children; the per-machine `~/.claude/orchestration/` state matches
  Claude Code's overall per-machine convention.
- **No Claude-driving-Claude interactive loop.** The primary doesn't
  type into another session's prompt. All inter-session communication
  is file-mediated (inbox/outbox) or via the official `SendMessage`
  / `SendUserMessage` tools.
- **No web/UI.** `orch-status.sh` is the surface.
- **No replacement for Task Scheduler.** Scheduled bot launches
  (GS-Stream-A7-0830, A8-1230, A9-1630) continue via Task Scheduler;
  orchestration layer reads their state, doesn't initiate them.

## Failure modes designed around

1. **PATH not propagating** to detached children — `spawn-detached.ps1`
   inherits `run_session.bat`'s canonical PATH (`C:\Program Files\Git\bin`,
   `~/.bun/bin`, `~/.local/bin`, `~/AppData/Roaming/npm`).
2. **Primary session overload mid-spawn** — metadata files written
   immediately at spawn time so the next primary session can read
   state from disk; the spawned process keeps running independently.
3. **Stale spawns** — `orch-status.sh` flags spawns whose
   `last_heartbeat` is stale relative to expected cadence.
4. **OPENROUTER_ENV_FILE missing** — the bot-launcher path inherits
   from the spawning shell or defaults to MiroShark `.env`. Failure
   is loud at first cycle.
5. **Multiple simultaneous bot launches racing on the same worktree** —
   bot already uses `bot/work` worktree branching; multiple
   spawn-detached.ps1 launches against the same project would race.
   The status reader can detect this; primary session checks before
   spawning.

## Rationale

See `docs/internal/SESSION-ORCHESTRATION-2026-04-24.md` (private repo)
for the design write-up that produced this layer. See `Hammerstein
Observations - Claude.md` § "2026-04-24 evening — Reinventing a proven
tool instead of using it" for the structural-reframe lesson that
motivated routing side-quests off the primary session.
