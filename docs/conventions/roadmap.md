# Phased roadmap (`ROADMAP.yaml`)

A managed project can declare a phased campaign in
`state/<project>/ROADMAP.yaml`. Each phase has a goal, completion
criteria, and the tasks that should be queued when the phase
begins. The dispatcher detects phase completion and the commander
advances phases manually via `generalstaff phase advance`.

This is the **Phase A v1** scope from
[`docs/internal/FUTURE-DIRECTIONS-2026-04-19.md`](../internal/FUTURE-DIRECTIONS-2026-04-19.md):
schema + manual advance only. Dispatcher integration (auto-detect
at session start) and dashboard surfacing land in Phase B.

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
The audit log gets two new event types:

- `phase_complete` — emitted when criteria pass. Data carries
  `{phase_id, criteria_results, forced, timestamp}`.
- `phase_advanced` — emitted when the advance has seeded the next
  phase's tasks. Data carries `{from_phase, to_phase,
  seeded_task_ids, timestamp}`.

## CLI reference

```
generalstaff phase init     --project=<id> [--force]
generalstaff phase status   --project=<id> [--json]
generalstaff phase advance  --project=<id> [--force]
generalstaff phase --help
```

- `init` — scaffolds a starter ROADMAP.yaml. Refuses to overwrite
  without `--force`.
- `status` — shows current phase, goal, next phase, completed
  phases, and per-criterion pass/fail. `--json` for machine-
  readable output.
- `advance` — evaluates criteria; advances if all pass. `--force`
  bypasses the criteria gate (records `forced: true` in the
  audit log). Refuses to advance from a terminal phase (no
  `next_phase`).

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
