# Phased roadmap (`ROADMAP.yaml`)

A managed project can declare a phased campaign in
`state/<project>/ROADMAP.yaml`. Each phase has a goal, completion
criteria, and the tasks that should be queued when the phase
begins. The dispatcher detects phase completion and the commander
advances phases manually via `generalstaff phase advance`.

This is the **Phase A + Phase B v1** scope from
[`docs/internal/FUTURE-DIRECTIONS-2026-04-19.md`](../internal/FUTURE-DIRECTIONS-2026-04-19.md):

- **Phase A** (shipped 2026-05-03 morning): schema, validator,
  criteria evaluator, per-project state tracker, manual `gs phase
  advance` command.
- **Phase B** (shipped 2026-05-03 evening): dispatcher hook at
  session start that auto-detects ready phases, writes a
  `PHASE_READY.json` sentinel, emits `phase_ready_for_advance` to
  the audit log, and surfaces ready projects via `gs view
  phase-ready`. Auto-advance is OFF by design — the commander
  still runs `gs phase advance` to actually transition. Dashboard
  UI rendering of the phase-ready view is deferred to a future
  pass; the JSON view module is already exposed.

## Quick start

Scaffold a starter file:

```bash
generalstaff phase init --project=myapp
```

Edit the resulting `state/myapp/ROADMAP.yaml` to describe your
campaign. Then check status:

```bash
generalstaff phase status --project=myapp
```

When the current phase's criteria all pass, advance:

```bash
generalstaff phase advance --project=myapp
```

`advance` records a `phase_complete` event in `PROGRESS.jsonl`,
seeds the next phase's tasks into `state/myapp/tasks.json`, and
flips `current_phase` in `state/myapp/PHASE_STATE.json`.

## Schema

```yaml
project_id: <string>           # Must match registry id
current_phase: <string>        # The phase id the project is on now

phases:
  - id: <string>               # Unique within phases list
    goal: <string>             # One-line description
    depends_on: <string>       # (optional) phase id this depends on
    tasks:                     # (optional) literal tasks seeded on advance
      - title: <string>
        priority: <number>     # Default 2
        interactive_only: <bool>          # (optional)
        interactive_only_reason: <string> # (optional)
        expected_touches: [<string>, ...] # (optional)
    completion_criteria:       # List of criteria; ALL must pass to advance
      - <criterion>
    next_phase: <string>       # (optional) phase id to advance to
```

`current_phase` must reference a phase declared in the `phases`
list. `next_phase` and `depends_on` references are validated at
load time. `tasks_template` is reserved for a future release; v1
rejects it.

## Completion criteria

A criterion is a single-key mapping. `generalstaff phase advance`
evaluates every criterion declared on the current phase; all
must return `passed: true` (or you must use `--force`).

### v1: supported

#### `all_tasks_done: true`

Passes when every task in `state/<project>/tasks.json` has
`status: done | skipped | superseded`. Vacuously passes when no
tasks file exists. The detail message lists up to 5 unfinished
task ids when the criterion fails.

```yaml
completion_criteria:
  - all_tasks_done: true
```

#### `custom_check: "<bash one-liner>"`

Passes when the bash command exits 0. The dispatcher runs it in
the project's repo root (`projects.yaml.path`), inheriting the
session's environment. Stderr tail is captured into the failure
detail.

The command should be **read-only** by convention. The dispatcher
does not enforce read-only-ness — that's the operator's
discipline.

```yaml
completion_criteria:
  - custom_check: "bun test --silent"
  - custom_check: "git diff --quiet origin/main"
  - custom_check: "test -f public/dist/index.html"
```

### v1: declared but not evaluated

The schema accepts these criteria so a roadmap can declare them
without breaking validation, but `phase advance` returns
`passed: false` with detail "not implemented in v1" for each. The
operator either drops them, replaces them with `custom_check`
equivalents, or waits for Phase B.

- `launch_gate: "<gate-id>"` — for future LAUNCH-PLAN.md unification
- `git_tag: "<tag>"` — for future tag-watching
- `lifecycle_transition: "dev -> live"` — for future lifecycle flips

## Example: a minimal two-phase roadmap

```yaml
project_id: myapp
current_phase: mvp

phases:
  - id: mvp
    goal: "Working end-to-end flow, 0 users"
    completion_criteria:
      - all_tasks_done: true
      - custom_check: "bun test --silent"
    next_phase: launch

  - id: launch
    goal: "Public launch with at least one real user"
    depends_on: mvp
    tasks:
      - title: "Smoke-test the live deployment"
        priority: 1
      - title: "First-user announcement post"
        priority: 2
    completion_criteria:
      - all_tasks_done: true
```

The MVP phase is open-ended (you write tasks into `tasks.json`
manually as the campaign unfolds). The launch phase is concrete:
two tasks, both seeded automatically when `phase advance` runs.

## Example: gamr's draft (illustrative)

The `FUTURE-DIRECTIONS-2026-04-19.md` design doc proposes gamr as
the first real test case. Its draft roadmap has four phases —
mvp, billing, ads, launch — each gated on tests + custom checks +
specific tasks. See the design doc for the worked example.

## State files

### `state/<project>/ROADMAP.yaml`
The canonical campaign description. Edit by hand; the dispatcher
reads it but does not write it.

### `state/<project>/PHASE_STATE.json`
Runtime state. Tracks `current_phase` (which may differ from
`ROADMAP.yaml.current_phase` after manual advances) and the
`completed_phases` list with timestamps and criteria-results
captured at advance time.

The dispatcher writes this file via `phase advance`; you should
not edit it by hand. To rewind a phase advance, edit it (Phase A
has no `phase rollback` command — that's a Phase B item).

### `state/<project>/PROGRESS.jsonl`
The audit log gets three new event types:

- `phase_ready_for_advance` (Phase B) — emitted at session start
  when the dispatcher detects a phase whose criteria all pass and
  has a non-terminal `next_phase`. Data carries `{from_phase,
  to_phase, criteria_results}`. Idempotent: if the same readiness
  was already detected for the same `{from_phase, to_phase}`, the
  sentinel file is rewritten with a fresh timestamp but no
  duplicate event is emitted.
- `phase_complete` (Phase A) — emitted when `gs phase advance`
  runs and criteria pass. Data carries `{phase_id,
  criteria_results, forced, timestamp}`.
- `phase_advanced` (Phase A) — emitted when the advance has
  seeded the next phase's tasks. Data carries `{from_phase,
  to_phase, seeded_task_ids, timestamp}`.

### `state/<project>/PHASE_READY.json` (Phase B sentinel)
Written by the session-start phase-progression detector when a
project's current phase is ready to advance. Read by the
`phase-ready` view module + (future) dashboard Attention panel.
Cleared automatically by `gs phase advance` after a successful
transition.

## CLI reference

```
generalstaff phase init     --project=<id> [--force]
generalstaff phase status   --project=<id> [--json]
generalstaff phase advance  --project=<id> [--force]
generalstaff phase --help

generalstaff view phase-ready [--json]
```

- `phase init` — scaffolds a starter ROADMAP.yaml. Refuses to
  overwrite without `--force`.
- `phase status` — shows current phase, goal, next phase,
  completed phases, and per-criterion pass/fail. `--json` for
  machine-readable output.
- `phase advance` — evaluates criteria; advances if all pass.
  `--force` bypasses the criteria gate (records `forced: true`
  in the audit log). Refuses to advance from a terminal phase
  (no `next_phase`). Clears the `PHASE_READY.json` sentinel on
  success.
- `view phase-ready` — list of projects with a sentinel file
  present (i.e., the session-start detector flagged them ready
  to advance). Sorted oldest-detected first. `--json` for
  machine-readable output. Phase B's primary read surface.

## Session-start detection (Phase B)

When `generalstaff session` (or any session loop) starts, the
dispatcher iterates every registered project and runs the same
criteria evaluator that `phase status` uses. For each project
where the criteria all pass AND the current phase has a
non-terminal `next_phase`:

1. The detector writes a `PHASE_READY.json` sentinel file.
2. It emits a `phase_ready_for_advance` event to PROGRESS.jsonl
   (idempotent — same readiness for the same `{from, to}` pair
   doesn't re-emit).
3. The session log prints a one-liner: `[phase] <project>: ready
   to advance <from> -> <to>`.

The detection is `dryRun`-aware: dry-run sessions skip detection
so they remain side-effect-free.

The commander then runs `gs phase advance --project=<id>` (or
inspects the queue with `gs view phase-ready`). Auto-advance is
**off by default** — the design doc §2 calls this the
"commander gate" and frames it as an explicit trust-building
step.

### Opt-in auto-advance (Phase B+, 2026-05-04)

Set `auto_advance: true` at the top of `ROADMAP.yaml` (sibling of
`current_phase`) to have the session-start detector run the
equivalent of `gs phase advance` automatically when the current
phase's criteria all pass. The advance still emits
`phase_complete` + `phase_auto_advanced` to `PROGRESS.jsonl` (the
event name is distinct from the manual-path `phase_advanced` so
later audit can tell them apart) and seeds the next phase's
literal tasks the same way.

```yaml
project_id: myapp
current_phase: mvp
auto_advance: true   # Opt in.

phases:
  - id: mvp
    completion_criteria:
      - all_tasks_done: true
    next_phase: launch
  ...
```

When `auto_advance: true`, the detector does NOT write
`PHASE_READY.json` — the advance is unconditional once criteria
pass. Forced advances still require the manual `gs phase advance
--force` path (auto-advance never bypasses failing criteria).

Recommended usage: turn on for projects where the phase boundaries
are mechanical and well-tested (e.g. a `dev → live` lifecycle
flip on a low-stakes side project). Keep off for any project with
voice-bearing or stakeholder-facing transitions where you want a
human eyeball before flipping.

### Multi-phase rollback (Phase B+, 2026-05-04)

When you advance a phase by mistake — wrong criteria pass, premature
trigger, accidental `--force` — `gs phase rollback` walks back to a
prior phase:

```bash
generalstaff phase rollback --project=myapp --to=mvp
```

The command pops phases off `completed_phases` until the target is
re-opened as `current_phase`. It emits a `phase_rolled_back` event
to `PROGRESS.jsonl` carrying `{from_phase, to_phase, undone_phases,
forced}`.

**What rollback does NOT do:** it leaves tasks seeded by previous
advances in `tasks.json`. Phase advances materialize literal tasks
into the queue; commanders may have edited or worked on those tasks
already, so removing them automatically would conflict with state
the commander cares about. Use `generalstaff task done` /
`task rm` to clean up after a rollback if needed.

**`--force` flag:** allows targeting a phase that's NOT in
`completed_phases` (e.g. you want to set `current_phase` directly to
a phase you've never been on, or that fell off history). Sets the
field directly without touching `completed_phases`.

```bash
# Walk back through history (target must be in completed_phases):
generalstaff phase rollback --project=myapp --to=mvp

# Or set current_phase directly (target NOT in history):
generalstaff phase rollback --project=myapp --to=mvp --force
```

### Tasks templates with placeholder expansion (Phase B+, 2026-05-04)

In addition to literal `tasks:`, a phase can declare
`tasks_template:` — same shape, but string fields support
placeholder substitution at advance time:

```yaml
phases:
  - id: launch
    tasks:
      - title: "Smoke-test the live deployment"
        priority: 1
    tasks_template:
      - title: "Cut the {phase_id} release tag"
        priority: 2
      - title: "Post {phase_id} announcement on {date}"
        priority: 3
        interactive_only: true
        interactive_only_reason: "Voice-bearing copy for {project_id}"
        expected_touches: ["docs/{phase_id}/announcement.md"]
```

When the phase is advanced into, both `tasks:` (verbatim) and
`tasks_template:` (with placeholders resolved) are seeded into
`tasks.json`. Literal tasks come first, then templated.

**Supported placeholders:**

| Placeholder      | Resolves to                                              |
|------------------|----------------------------------------------------------|
| `{phase_id}`     | The phase being entered (e.g. `launch`)                  |
| `{prev_phase}`   | The phase being advanced from (e.g. `mvp`)               |
| `{project_id}`   | The project's registry id                                |
| `{date}`         | UTC date in `YYYY-MM-DD` (advance-time)                  |
| `{datetime}`     | UTC ISO 8601 `YYYY-MM-DDTHH:MM:SSZ` (advance-time)       |

Unknown placeholders are rejected at `loadRoadmap` time so typos
fail fast instead of materializing into your task queue. Adding
a new placeholder requires updating `SUPPORTED_PLACEHOLDERS` in
`src/phase.ts`, `buildExpansionContext`, and this table.

Placeholders apply in `title`, `interactive_only_reason`, and each
`expected_touches` entry. Non-string fields (`priority`,
`interactive_only`) pass through unchanged.

## Hands-off interaction

Tasks seeded by `phase advance` go through the same
`isTaskBotPickable` gate the rest of the queue uses. If you
declare an `expected_touches` list on a phase task and it
intersects the project's `hands_off` patterns, the bot picker
will skip the task. Use this to keep voice-bearing or safety-
critical tasks in the interactive queue rather than the
bot-pickable one.

```yaml
tasks:
  - title: "Write the launch announcement post"
    priority: 1
    interactive_only: true
    interactive_only_reason: "Voice-bearing copy. Operator drafts."
  - title: "Cut the v1.0.0 git tag"
    priority: 2
    expected_touches: ["scripts/release.sh"]  # if scripts/ is hands_off
```

## What this isn't (per design doc §6)

- Not a project management tool. No calendar, no owners, no
  velocity tracking.
- Not a replacement for judgment. The commander writes the
  roadmap (taste work, Hard Rule 1).
- Not Jira / Linear / Notion integration. Plain YAML in the
  project's state dir.
- Not infallible. Completion criteria can lie (a passing test
  suite can still miss a bug). The verification gate remains
  the catch-all.

## Related docs

- [`docs/internal/FUTURE-DIRECTIONS-2026-04-19.md`](../internal/FUTURE-DIRECTIONS-2026-04-19.md)
  — original design doc with §1-§9 covering schema, auto-seed
  flow, UI integration, open questions, and v1 scope.
- [`docs/conventions/usage-budget.md`](usage-budget.md) — sibling
  v0.2.0 feature using a similar criteria-evaluation pattern.
- [`projects.yaml.example`](../../projects.yaml.example) — how
  to register a project that will use a phased roadmap.
