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
├── spawn-detached.ps1                  # Tier 2 spawn (detached cmd, survives primary)
├── spawn-tier2.sh                      # Tier 1 spawn (background claude -p)
├── orch-status.sh                      # snapshot: spawns + launches + fleet + processes
├── orch-list.sh                        # parseable: <id>\t<role>\t<state>\t<age>
├── orch-send.sh                        # append message to spawn's inbox
├── orch-kill.sh                        # signal graceful shutdown to a spawn
├── needs-ray-watch.sh                  # for the Monitor harness primitive
└── roles/
    ├── bot-launcher.md                 # wrapper-only role (runs run_session.bat)
    ├── deep-dive.md                    # focused project work session
    └── monitor.md                      # ambient observability watcher
```

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
