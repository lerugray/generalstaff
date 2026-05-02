# GeneralStaff — Architecture Sketch

Status: design only, not yet implemented. Captured 2026-04-13 from an
interactive session with Ray. To be folded into a build session in the
next 1-2 days.

## Goal

Run autonomous Claude Code work on multiple of Ray's local projects in
sequence, overnight, with file-based state, role-scoped agents, and
per-project configuration. Ray reviews output in the morning across all
projects.

## Constraints (already decided)

1. **File-based state only.** No databases, daemons, web dashboards, MCPs
   beyond what Claude Code already provides. Shell + Claude Code + git +
   files.
2. **Sequential MVP.** One project per cycle. Parallel worktrees come in
   Phase 4 after sequential stability is proven.
3. **Polsia Planner → Engineer → Reviewer pattern**, applied at two levels:
   a meta-dispatcher (picks which project gets the cycle) and per-project
   chains (Planner picks task within that project, Engineer executes,
   Reviewer checks).
4. **Auto Mode (`--enable-auto-mode`) preferred** over
   `--dangerously-skip-permissions` if it exists in current Claude Code.
   The safety classifier flags irreversibility specifically, which is the
   right shape for cross-project work where one bad rm could nuke another
   project.
5. **Per-project hands-off lists are mandatory.** Every project registered
   in `projects.yaml` must declare what files/dirs the bot must not touch.
   No file = no registration.

## Architecture (Phase 1 MVP — sequential, single-project-per-cycle)

```
                  ┌─────────────────────┐
                  │  Cron / .bat        │  (fires nightly at e.g. 11PM,
                  │  workday launcher   │   or one-shot from terminal)
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  GeneralStaff       │  reads projects.yaml +
                  │  meta-dispatcher    │  fleet_state.json, picks
                  │  (shell script)     │  next project by priority *
                  └──────────┬──────────┘  staleness
                             │
                  ┌──────────▼──────────┐
                  │  Project X's        │  fresh-context Claude with
                  │  Planner agent      │  read-only tools, picks task
                  │  (Claude -p)        │  from X's backlog
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Project X's        │  fresh-context Claude with
                  │  Engineer agent     │  full edit tools, executes on
                  │  (Claude -p)        │  bot/work branch
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Project X's        │  fresh-context Claude with
                  │  Reviewer agent     │  read + git tools only,
                  │  (Claude -p)        │  reviews and writes verdict
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Update fleet       │  fleet_state.json, X's
                  │  state + send       │  project state, log, then
                  │  morning digest     │  Telegram digest
                  └─────────────────────┘
```

## Per-project file layout

Each registered project gets a `.generalstaff/` directory at its root
(committed or gitignored at the project's discretion — catalogdna would
gitignore since it's already public-facing). Pattern adapted from
nightcrawler:

```
<project>/
├── .generalstaff/
│   ├── MISSION.md         # static; what this project is about, who it
│   │                       # serves, what shipping looks like
│   ├── STATE.json         # machine-readable: last cycle, status, in-flight
│   ├── HANDOFF.md         # narrative handoff from previous cycle
│   ├── tasks.json         # current work queue
│   ├── PROGRESS.jsonl     # append-only log of every cycle's outcome
│   └── REVIEW.md          # most recent reviewer verdict
└── ... (rest of project)
```

The `MISSION.md` replaces what catalogdna currently has scattered across
`CLAUDE.md`, `AI Collaboration Principles.md`, etc. It's a focused 1-page
"what this project is, who it's for, what shipping looks like, what NOT
to touch."

## Project registry schema

`GeneralStaff/projects.yaml`:

```yaml
projects:
  - id: catalogdna
    path: C:/Users/rweis/OneDrive/Documents/catalogdna
    priority: 1                    # 1 = highest, 5 = lowest
    cycle_minutes: 360             # hard timeout per cycle
    mission_file: .generalstaff/MISSION.md
    backlog_glob: docs/bot-proposals/*.md
    branch: bot/work
    verification_command: "py -m pytest tests/ -q"
    auto_merge: false              # MUST be false until 5 clean cycles
    hands_off:
      - src/catalogdna/interpret/
      - CLAUDE.md
      - CLAUDE-AUTONOMOUS.md
      - .claude/
      - run_bot*.sh
      - run_bot*.bat
      - bot_tasks.md
    last_cycle_at: null            # updated by dispatcher
    last_cycle_outcome: null       # updated by dispatcher
```

See `projects.yaml.example` for the full annotated schema.

## Dispatcher cycle (pseudocode)

```python
def run_cycle():
    fleet_state = load_fleet_state()
    projects = load_projects_yaml()

    # Honor kill switch
    if STOP_FILE.exists():
        log_and_exit("STOP file present at fleet root")

    # Pick project by priority * staleness (days since last cycle)
    next_project = pick_next(projects, fleet_state)
    if next_project is None:
        log_and_exit("no eligible project")

    # Per-project chain
    write_state(next_project, "planner_running")
    plan = run_planner(next_project)        # Claude -p, read-only
    if not plan.has_work:
        log_cycle(next_project, "no_work")
        return

    write_state(next_project, "engineer_running")
    engineer_outcome = run_engineer(next_project, plan)

    write_state(next_project, "reviewer_running")
    review = run_reviewer(next_project, engineer_outcome)

    if review.verdict == "merge":
        if next_project.auto_merge:
            merge_to_master(next_project)
        else:
            write_morning_digest(next_project, review, "ready_to_merge")
    elif review.verdict == "escalate":
        write_morning_digest(next_project, review, "needs_attention")

    log_cycle(next_project, "ok")
    update_fleet_state(next_project)
```

## Safety rules (non-negotiable)

These are the hard rules baked into the dispatcher's core. Adding to this
list is fine; relaxing is not.

1. **Never push to master directly.** Always work on a per-project bot
   branch.
2. **Never force-push, never `--no-verify`, never skip pre-commit hooks.**
3. **Never delete files outside the current project's working directory.**
4. **Never write to a project not in `projects.yaml`.**
5. **Auto Mode (`--enable-auto-mode`) over `--dangerously-skip-permissions`**
   if available. Both are needed for unattended operation; the difference
   is that Auto Mode flags irreversible actions for the safety classifier
   instead of waving everything through.
6. **Per-cycle token / time budget cap** — fail-fast on overrun rather
   than debugging at 3 AM.
7. **Fatal error → graceful exit + Telegram alert.** Never retry-loop on
   error.
8. **Daily backup** of all `.generalstaff/` state files before any cycle
   starts. Just `git add -A && git commit -m "generalstaff: nightly state
   snapshot"` in a state-only repo or branch.
9. **Hands-off files list per project** is enforced at the Engineer
   agent's tool level (Claude Code permission denials, not just
   instructions).
10. **No cross-project writes.** The Engineer agent for project X cannot
    write to project Y's directory, ever. Enforced via the dispatcher
    spawning each agent with cwd=project_path and explicit deny rules.
11. **STOP kill-switch file.** The dispatcher checks for `STOP` at fleet
    root before each cycle and exits if present. Lets Ray pause the fleet
    from any machine by `touch STOP` and resume with `rm STOP`.

## Phased build plan

**Phase 1 — Sequential MVP.**
Single project per cycle, file-based state, manual review. Wire up
catalogdna only. Validate over ~1 week of nightly runs.

**Phase 2 — Add second project.**
Pick the simplest second project from Ray's list (likely Retrogaze
pipeline work or Sandkasten non-game-logic work). Generate its
`.generalstaff/MISSION.md`, register it, dry-run, then live.

**Phase 3 — Add Reviewer pass.**
The Reviewer is currently in the design but optional. Once we have ~5
successful runs, add a separate fresh-context review agent that reads
the cycle's commits and writes a verdict before merge. Borrow from
Polsia's PM → Engineer → QA pattern.

**Phase 4 — Parallel worktrees across projects.**
Multi-project parallel runs. Only attempt after sequential MVP has been
clean for ~2 weeks.

**Phase 5 — Hooks for state I/O.**
Move STATE/HANDOFF reads and writes into Claude Code's `SessionStart` /
`SessionEnd` hooks per the Continuous-Claude-v3 pattern — removes "did
the model remember to update state?" as a failure mode.

## Open questions (resolve before building Phase 1)

1. **Where does the dispatcher run?** Cron'd from Windows Task Scheduler?
   Manually launched via .bat? An always-on `while true` loop that sleeps
   between cycles? Probably the .bat launcher pattern catalogdna already
   uses, possibly extended with Task Scheduler for nightly auto-launch.
2. **What's the cycle picker algorithm?** Pure priority × staleness, or
   does Ray override per-cycle via a `next_project` file? Recommend the
   latter — gives Ray weighted control without losing automation.
3. **What gets registered as project #2?** Per the project list
   conversation (2026-04-13 evening interactive session), the candidates
   are Retrogaze (pipeline work in experimental branch, eyeballable
   output) or Sandkasten (non-game-logic work, hard-rule constrained).
   Both need a backlog generated first. Auftragstaktik and Bookfinder are
   conditional on backlog generation. Zero Page is OUT (creative work,
   abandoned, see creative-vs-mechanical rule).
4. **How does Ray monitor overnight without checking his phone?**
   Telegram inbox channel (catalogdna already uses this pattern) for
   fleet status. Per-cycle "I'm starting project X" + "I finished
   project X with verdict Y" pings, plus a single morning digest with
   per-project summaries.
5. **Do we want a "kill switch" file?** Yes — `STOP` at fleet root,
   checked before each cycle. Already in safety rules above.
6. **Per-project mission file vs CLAUDE.md?** Each project already has
   a CLAUDE.md (or could). Does `.generalstaff/MISSION.md` duplicate it?
   Recommend: MISSION.md is shorter (1 page), focused on the bot's
   decision-making needs ("what shipping looks like"). CLAUDE.md is the
   broader human-facing project context. Both, but with clear separation
   of audience.

## What this design is NOT

- Not a replacement for catalogdna's existing bot. The catalogdna bot's
  loop logic, Phase A/B protocol, Chrome review loop, and Hammerstein
  framing all stay. GeneralStaff wraps it as one of N projects.
- Not an attempt to build a generic "AI agent platform." It's a personal
  fleet manager for Ray's specific projects.
- Not auto-PR / auto-merge by default. Reviewer verdicts go to a morning
  digest first; auto-merge enables only after a project has 5+ clean
  cycles.
- Not parallelized in MVP. Throughput is Phase 4.
- Not opinionated about LLM choice — defaults to Claude Code, but each
  per-project agent could in principle use a different model if cost
  matters later.

## References

See `docs/internal/research-notes.md` for verbatim findings from the background research
agent on nightcrawler, parallel-cc, Polsia, and Continuous-Claude-v3.
The top 3 design decisions there (file-based state per project,
git-as-source-of-truth verification ritual, hooks for state I/O) are
load-bearing for this design.

---

## v2 — Open-source pivot extensions (2026-04-15)

This section extends v1 above. **Nothing in v1 is removed.** The pivot
to an open-source product is documented in `docs/internal/PIVOT-2026-04-15.md`; the
rule changes are in `docs/internal/RULE-RELAXATION-2026-04-15.md`. Read those first
— this section assumes you have.

The v2 architecture adds three things to v1:

1. A **verification gate** that promotes the Phase A/B "ritual" into
   a load-bearing Hard Rule (Rule #6).
2. A **local UI shell** (Tauri preferred, Bun-served browser tab
   acceptable during development) as a viewer/controller over the
   file-based state. Permitted under the relaxation of Rule #2.
3. An **open audit log** (`PROGRESS.jsonl`) that records every
   prompt, response, tool call, and diff per cycle (Hard Rule #9).

### Updated architecture (v2)

```
                  ┌─────────────────────┐
                  │  Cron / .bat /      │
                  │  workday launcher   │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐         ┌────────────────┐
                  │  GeneralStaff       │◄────────│  Local UI      │
                  │  meta-dispatcher    │ reads/  │  (Tauri)       │
                  │  (CLI)              │ writes  │  viewer +      │
                  └──────────┬──────────┘ same    │  controller    │
                             │            files   └────────────────┘
                  ┌──────────▼──────────┐
                  │  Project X's        │
                  │  Planner agent      │
                  │  (Claude -p, RO)    │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Project X's        │
                  │  Engineer agent     │
                  │  (Claude -p, RW)    │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Verification gate  │ ← HARD RULE #6
                  │  - tests pass?      │
                  │  - diff non-empty?  │
                  │  - scope match?     │
                  └──────────┬──────────┘
                       FAIL  │  PASS
                  ┌──────────▼──────────┐
                  │  Project X's        │
                  │  Reviewer agent     │
                  │  (Claude -p, RO+    │
                  │  git diff)          │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Update fleet state │
                  │  + write PROGRESS   │
                  │  audit entry        │
                  │  + morning digest   │
                  └─────────────────────┘
```

The Local UI is a separate process. The CLI is fully usable without
it. The UI never touches state files except through the same code
paths the CLI uses (Hard Rule #2 relaxation constraint).

### Per-project file layout (v2 additions)

```
<project>/
├── .generalstaff/
│   ├── MISSION.md           # static; same as v1
│   ├── STATE.json           # current cycle state; same as v1
│   ├── HANDOFF.md           # narrative handoff; same as v1
│   ├── tasks.json           # work queue; same as v1
│   ├── PROGRESS.jsonl       # NEW IN v2: full audit log per Rule #9
│   ├── REVIEW.md            # most recent verdict; same as v1
│   ├── verification.log     # NEW IN v2: most recent test/build output
│   └── cycles/              # NEW IN v2: per-cycle artifact directory
│       ├── 2026-04-16-01/
│       │   ├── plan.md
│       │   ├── engineer-prompt.txt
│       │   ├── engineer-response.txt
│       │   ├── diff.patch
│       │   └── verification.log
│       └── 2026-04-16-02/
│           └── ...
└── ... (rest of project)
```

> **Refinement (2026-04-15 evening):** The per-project
> `.generalstaff/` layout shown above — with state living
> INSIDE each managed project — was the original
> nightcrawler-inspired pattern. It was **refined for Phase 1**
> so that state lives in **GeneralStaff's own directory** under
> `state/${project_id}/` rather than inside each managed project.
>
> **Why:** cross-project contamination safety. With the original
> layout, an accidental `git add -A` in catalogdna could pull
> GeneralStaff state into catalogdna's public repo. The new
> layout makes that structurally impossible because GeneralStaff
> never writes files into managed projects' working trees at all.
> The Engineer subprocess (`bash run_bot.sh`) still writes to
> catalogdna's `bot/work` branch — that's catalogdna's own bot
> doing its own thing — but GeneralStaff itself doesn't.
>
> See `docs/internal/PHASE-1-RESOLUTIONS-2026-04-15.md` §Q5 for the full
> rationale and the new layout. The v1 layout above is preserved
> as historical context (per the append-only design convention);
> the `state/${project_id}/` layout supersedes it for
> implementation.

### Verification gate spec

After the Engineer agent finishes, the dispatcher (not the model)
runs the gate:

```python
def verify_cycle(project, cycle):
    # 1. Run the project's verification command
    result = subprocess.run(
        project.verification_command,
        cwd=project.path,
        timeout=project.verification_timeout_seconds,
        capture_output=True,
    )
    if result.returncode != 0:
        return Verdict("verification_failed", reason="tests failed",
                       log=result.stdout + result.stderr)

    # 2. Check that git diff is non-empty
    diff = subprocess.run(
        ["git", "diff", f"{cycle.start_sha}..HEAD"],
        cwd=project.path, capture_output=True,
    ).stdout
    if not diff.strip():
        return Verdict("verification_failed", reason="empty diff")

    # 3. Reviewer agent confirms scope match
    review = run_reviewer_agent(project, cycle, diff)
    if review.verdict == "scope_drift":
        return Verdict("verification_failed", reason=review.reason)

    return Verdict("verified", review=review)
```

A `verification_failed` cycle:
- Is **not** marked `done` in `STATE.json`
- **Does** keep its branch and diff for human review
- **Does** write a digest entry with the failure reason
- **Does not** auto-merge under any circumstances

The dispatcher refuses to enable `auto_merge: true` for projects
whose `verification_command` is empty, `true`, or otherwise a no-op.
(See open question #6 in `docs/internal/RULE-RELAXATION-2026-04-15.md` §4.)

### Local UI spec (high level)

**Stack:** Tauri (Rust shell + WebView) for the shipped product.
Local Bun HTTP server with `xdg-open localhost:PORT` is the
development fallback.

**Read views (Phase 4):**
- Fleet overview — list of registered projects with last-cycle
  status, staleness, current verdict
- Per-project drill-down — STATE, HANDOFF, current task, last
  verdict, last verification log
- Cycle history — paginated PROGRESS.jsonl viewer with filters
  by project / agent role / outcome
- Live tail — current cycle output streamed from the CLI

**Control surface (Phase 5):**
- Pause / resume the dispatcher (writes `STOP` file)
- Reorder priorities (writes `next_project.txt`)
- Approve / reject pending reviewer verdicts
- Trigger one-off cycle for a specific project
- View and edit hands-off lists per project (with confirmation)

**What the UI does NOT do:**
- Store state of its own (no DB, no localStorage of dispatcher state)
- Run agents directly (always shells out to the CLI)
- Authenticate users (it's a local app on the user's machine)
- Phone home (no telemetry, no analytics, no external network calls)

### Open audit log entry format

`PROGRESS.jsonl` is append-only newline-delimited JSON. One entry
per significant dispatcher event. Schema:

```json
{
  "ts": "2026-04-15T22:31:08Z",
  "cycle_id": "2026-04-15-03",
  "project_id": "catalogdna",
  "event": "agent_response",
  "agent_role": "engineer",
  "model": "claude-opus-4-6",
  "prompt": "<full prompt sent to model>",
  "response": "<full response received>",
  "tool_calls": [
    {"tool": "Edit", "args": {"...": "..."}, "result": "..."}
  ],
  "diff_summary": "5 files changed, 42 insertions(+), 3 deletions(-)",
  "tokens": {"input": 12345, "output": 678}
}
```

Other event types: `cycle_start`, `cycle_end`, `verification_run`,
`verification_failed`, `verification_passed`, `reviewer_verdict`,
`merge`, `escalate`, `safety_block` (when a tool call is denied by
hands-off rules).

This is the file users `grep` when something goes wrong. It is also
the file that makes the project audit-able — every action the bot
took on the user's code is recorded with the prompt that caused it.

### Updated phased build plan

See `docs/internal/PIVOT-2026-04-15.md` for the full 12-phase plan with rationale.
Headlines:

- Phase 0: design docs (this conversation, 2026-04-15)
- Phase 1: sequential MVP for catalogdna + verification gate
- Phase 2: Reviewer pass with formal verification gate
- Phase 3: second Ray project
- Phase 4: Local UI read-only views
- Phase 5: Local UI control surface
- Phase 6: installable distribution (CLI + UI binary)
- Phase 7: public GitHub release (Ray writes launch posts by hand)
- Phase 8: parallel worktrees (was Phase 4 in original plan)
- Phase 9: SessionStart/SessionEnd hooks (was Phase 5)
- Phase 10: optional creative role plugins
- Phase 11: optional self-hosted cloud mode (never SaaS)

### v2 open questions

See `docs/internal/RULE-RELAXATION-2026-04-15.md` §4 for the canonical list:

1. UI framework choice (Tauri vs. Electron vs. Bun browser tab)
2. Anthropic ToS clarification for subscription quota
3. Plugin API design for opt-in creative roles
4. Telemetry policy (default: none)
5. Distribution channel (GitHub, Homebrew, winget, npx)
6. Verification gate edge cases (no tests, noop verification)

## v3 — Session-budget vs cycle-budget reservation math (2026-04-17, gs-125)

This section documents how the session loop reserves budget for each
cycle, the inefficiency that falls out of it, and the options for
handling that inefficiency. No code is changing here — this is a
design-doc capture so the trade-off is explicit before a future
session decides.

### The math today

The session loop (`src/session.ts`) pre-checks whether there is
enough budget remaining before starting a cycle:

```ts
// src/session.ts, ~line 237
const needed = currentProject.cycle_budget_minutes + 5;
if (remainingMinutes() < needed) {
  stopReason = "insufficient-budget";
  break;
}
```

The planner (`estimateSessionPlan` in `src/dispatcher.ts`, ~line 171)
mirrors this with `needed = top.project.cycle_budget_minutes + 5`.

That `+5` is a safety buffer covering reviewer invocation, digest
write, PROGRESS append, and general slop around the hard engineer
timeout. It is per cycle, not per session.

`cycle_budget_minutes` is declared per project in `projects.yaml`.
The example file currently recommends 45–60 min.

### Why this produces wasted session budget

A concrete example for a project with `cycle_budget_minutes: 30`
launched as `generalstaff session --budget=60`:

```
Session budget:           60 min
Reservation (cycle 1):    30 + 5 = 35 min
After cycle 1 starts:     60 - 35 = 25 min remaining
Can cycle 2 start?        needs 35 ≤ 25?   No.
→ only ONE cycle fits, and the loop exits with stopReason = "insufficient-budget".
```

In practice, cycles on well-scoped tasks run **4–8 min of wall
time** (observed on the GeneralStaff bot itself across 2026-04-16
and 2026-04-17 runs). So the reservation model leaves the session
wallclock mostly idle: one cycle runs for ~6 min, the remaining
~54 min of session budget are returned unused.

With `cycle_budget_minutes: 60` (closer to the example file's
current recommendation for GeneralStaff-shaped projects) the
effect is more extreme: a 60-min session fits **zero** cycles
(needed 65, have 60) and exits immediately.

The root cause is that `cycle_budget_minutes` is doing two jobs at
once:

1. **Hard timeout for the engineer subprocess** — needs to be high
   enough that a legitimate slow cycle (big refactor, large diff,
   reviewer retry) finishes rather than getting killed mid-edit.
2. **Reservation unit for the session picker** — smaller is better
   here, because the picker should admit a cycle whenever
   `remaining ≥ P(actual duration)` for most cycles, not whenever
   `remaining ≥ worst-case timeout`.

These two uses pull in opposite directions.

### Observed cycle durations (calibration input)

From the 2026-04-16 and 2026-04-17 bot-on-GeneralStaff runs
(PROGRESS.jsonl `cycle_end` events):

- p50 cycle duration: ~4–5 min
- p90 cycle duration: ~8 min
- p99 cycle duration: ~12 min (usually a reviewer retry or a
  watchdog-flagged stall)
- Observed max: ~18 min (bot stalled on a big test refactor,
  watchdog warned, eventually completed)

No cycle has legitimately hit the 30-min or 45-min ceiling on this
project. The ceiling exists to catch pathological cases (engineer
hung on a reviewer, infinite regeneration loop, etc.) where the
hard kill is the right answer.

This is informative but not conclusive — other projects will have
different distributions. catalogdna cycles (larger test suite,
more agent tool calls) are likely slower. The observed numbers
above are the GeneralStaff self-run baseline.

### Options

#### (a) Lower `cycle_budget_minutes` to match observed p99

Set the recommended default to something like `15` min for a
GeneralStaff-shaped project — still 2x the p90, comfortably above
the p99. The engineer hard-kill still protects against pathological
stalls. The reservation stops wasting budget.

**Pros:** simplest change. One-line edit to the example file.
Retroactively unblocks short sessions (a 60-min session can now
fit ~3 cycles instead of 1).

**Cons:** the budget is now per-project and every project author
has to calibrate it themselves. Under-set → legitimate cycles get
killed mid-task (lost work). Needs a migration note for existing
projects.yaml configs.

**Also:** projects that really do occasionally hit 25-min cycles
(catalogdna's larger refactors) now have their worst-case cycles
killed. The fix there is per-project tuning, not a shared default.

#### (b) Adapt based on moving-average cycle duration

Track the last N cycle durations per project in fleet state,
maintain an EWMA or p95, and use `max(ewma * k, floor_minutes)` as
the reservation unit while keeping `cycle_budget_minutes` as the
hard kill. `k` around 1.5–2, `floor_minutes` around 5 to prevent
cold-start starvation.

**Pros:** self-calibrating. New projects converge to their own
distribution after a handful of cycles. No per-project tuning
required. Handles the "catalogdna cycles are slow, GeneralStaff
cycles are fast" case naturally.

**Cons:** more code, more state in fleet_state.json, more tests,
more failure modes (e.g. what if a project has run zero cycles?
a single outlier cycle dragging the average up for days?). Adds
complexity to the planner's `estimateSessionPlan` preview.
Adaptive systems are also harder to reason about — "why did the
session pick only 2 cycles?" needs a second answer beyond "check
the budget math".

This is the "right" option but probably not the right option for
*right now*.

#### (c) Document as-is (status quo)

Leave the math alone. Treat wasted session budget as the price of
a simple, predictable reservation model. Document the math in this
design doc and the projects.yaml.example comments so users can
set `cycle_budget_minutes` sensibly themselves.

**Pros:** zero code change. Lowest risk. Aligned with the
"shipping matters more than perfecting" discipline from CLAUDE.md
§Project stakes. Preserves the one-variable-per-project mental
model.

**Cons:** continues wasting session-budget minutes. Makes short
sessions feel broken ("why did my 60-min run stop after one
cycle?") for new users who set `cycle_budget_minutes` at the
example file's 45–60 value.

### Proposal

**Adopt (a) now, keep (b) as a v3+ consideration.**

- Lower the `projects.yaml.example` recommended default from
  45–60 min to **15 min** for new projects. Add an inline
  comment explaining the two-jobs tension and pointing at this
  design section.
- Document the reservation math in the projects.yaml.example
  header block so users calibrate deliberately rather than
  copying the example default blindly.
- **Do not** change existing projects.yaml configs — this is a
  new-project default, not a retroactive rewrite. Existing users
  who want the benefit re-tune their own file.
- Revisit (b) only if multiple projects with very different cycle
  distributions are registered and the static default starts
  causing friction. The moving-average approach earns its code
  complexity only when per-project tuning stops scaling — not
  before.

This is a calibration change, not an architecture change. It
reads as boring on purpose. The reservation model itself stays.

### Open follow-ups (no code yet)

1. Should `cycle_budget_minutes` be split into two separate fields
   (`engineer_timeout_minutes` + `reservation_minutes`) to make
   the two-jobs tension explicit? Probably yes, eventually, but
   only once option (a) has been in production long enough to
   show whether the split is actually clarifying or just more
   knobs.
2. Should the session loop surface a one-line warning when it
   exits with `insufficient-budget` and only ran ≤1 cycle? e.g.
   "Hit the insufficient-budget stop after 1 cycle — your
   cycle_budget_minutes may be larger than your actual cycles
   need; see DESIGN.md §v3." This is cheap, catches the "my
   session stopped early" confusion, and is independent of
   whether (a), (b), or (c) is ultimately chosen.

## v4 — Reviewer-response parsing robustness (2026-04-18, observational)

**Status:** observational, not yet addressed in code. Captured
after the 2026-04-18 overnight session revealed a systematic
false-negative pattern in the verification gate. A fix is queued
as **gs-171**. Full technical detail is in docs/internal/research-notes.md
§"2026-04-18 — Verification-gate reviewer-JSON false-negatives";
this section captures the design-level conclusion.

### Observation

`src/reviewer.ts` currently parses reviewer responses with
strict `JSON.parse` on the outermost response body. Over the
24-hour window 2026-04-17T01:13 → 2026-04-18T01:11, ten cycles
hit `verification_failed` with reason "reviewer response was
not valid JSON". Sampling their archived `reviewer-response.txt`
files (preserved per Hard Rule #9) showed **every sampled
failure was an approved review** (`"verdict": "verified"`) that
parse-failed on a Qwen quirk: unescaped colons/quotes inside
the `task_evidence[].task` string field (`"task": "status": "done"`).

Result: 10 pieces of verified, tests-passing engineer work
silently rolled back by a parser stricter than the semantics
of the gate required.

### Design conclusion

**The verification gate's parse layer must be more tolerant
than the verdict semantics demand.** The semantics are:

- pass verification command ✓
- reviewer-approved scope ✓
- no hands-off violations ✓
- no silent failures ✓

The parser needs to extract *those* five fields robustly. It
does not need, and probably should not need, the
`task_evidence[]` structure to make a gate decision —
`task_evidence[]` is an audit-aid field, not a verdict
field. A parser that salvages the verdict even when
`task_evidence[]` is malformed preserves the gate's strict
semantics while eliminating the false-negative failure mode.

### Principle for future gate surfaces

When a machine-emitted structured response is consumed for a
pass/fail decision, **bifurcate the parser** by field purpose:

- **Decision-critical fields** (`verdict`, `scope_drift_files`,
  `hands_off_violations`, `silent_failures`) → strict schema,
  fail loud on anything suspicious.
- **Observational-aid fields** (`task_evidence`, `notes`,
  `reason`) → permissive extraction; drop malformed items,
  don't fail the whole response.

This is a generalization of the classic robustness principle
("be conservative in what you send, liberal in what you
accept") to structured LLM output. The cost of tightening
parser tolerance on observation-aid fields is close to zero;
the cost of false-negative rollbacks on decision-critical
correctness is full engineer-cycle wall time.

### Secondary principle — the open audit log earned its keep

This observation was only possible because every cycle's
`reviewer-response.txt` is archived at
`state/<project>/cycles/<cycle_id>/`. Without that archive,
the ten rolled-back cycles would read in PROGRESS.jsonl as
"reviewer didn't like the diff" and the real failure mode
would be invisible. Hard Rule #9 ("open audit log — full
prompts, responses, tool calls, and diffs in PROGRESS.jsonl
per cycle") bought the debugging surface that surfaced the
parser-robustness issue. A Phase N+ consolidation of the
rule should keep the per-cycle artifact archive explicit;
compressing PROGRESS.jsonl alone would have hidden this.

### Not in scope for v4

v4 does not redesign the verification gate's semantic model.
The gate's five-field verdict schema stays. What changes is
the parsing layer below the schema: from strict
`JSON.parse(responseBody)` to tolerant field-by-field
extraction with strict-required / permissive-optional
distinctions. gs-171 will land the parser change; a
follow-up may also tighten the reviewer prompt to discourage
Qwen from emitting unescaped inner content, as belt-and-braces.

## v5 — Auto-merge / chained-cycles dispatcher behavior (2026-04-18, gs-177)

**Status:** design only. Implementation is queued as **gs-177**.
This section is the design discussion that gs-177's code should
land against, written 2026-04-18 after the morning gamr-cycle
test (docs/internal/PHASE-3-COMPLETE-2026-04-18.md §"Generality gaps surfaced")
exposed that the current dispatcher caps every project at one
cycle per session when `auto_merge: false`, which is the
default per Hard Rule #4.

### The bug as observed

After the first verified gamr cycle landed on `bot/work`, the
dispatcher's preflight for cycle 2 hit `src/cycle.ts:467-497`:
"branch has unmerged commits ahead of HEAD; resetting would
destroy that work." That guard is correct (it prevents the
2026-04-16 silent-orphan bug from recurring), but the consequence
is that with `auto_merge: false` you get exactly one cycle per
project per session, then the dispatcher correctly refuses to
proceed.

### The induced contradiction with Hard Rule #4

Hard Rule #4 says auto_merge stays OFF until the user opts in
"after 5 clean verification-passing cycles." But with the
current dispatcher, getting to 5 cycles takes 5 separate
sessions — every session produces one cycle, then the user has
to manually merge `bot/work` into `master` before the next
session can do anything. For a non-dogfood project this means
the bot's first-meaningful work is gated on five rounds of
human merge-and-relaunch.

That's fine on dogfood (where Ray runs auto_merge=true after
the early manual cycles validated the gate), but it's
unworkable for the user-experience target: *"the process
should need as little human interaction as possible after
seeding the initial idea"* (Ray, 2026-04-18).

### Design constraints

1. **Verification gate must keep working as it does today.** A
   verified cycle's commits cannot be lost; a failed cycle's
   commits must roll back cleanly. (Hard Rule #6.)
2. **Hard Rule #4's spirit must hold.** Master cannot receive
   bot commits without either (a) explicit per-project opt-in
   or (b) a clear post-hoc audit window where the user can
   review and reject bot work before it gets blessed.
3. **Cycle atomicity.** Cycle N+1's failure cannot retroactively
   poison cycle N's verified commits.
4. **Minimal human interaction post-seed.** The user shouldn't
   have to merge after every cycle to unblock the next one. One
   review pass per N cycles is OK; per-cycle mid-session
   intervention is not.
5. **Engineer's view of the codebase needs to be coherent.**
   When cycle N+1 starts, the engineer needs to see at least
   tasks.json updated by cycle N (otherwise it picks the same
   task again). Ideally it sees ALL of cycle N's verified work,
   so successor tasks that depend on predecessors can compose.

### Three candidate designs

#### (a) Accumulator branch — `bot/work` keeps growing

**How it works.** Drop the "reset bot/work to HEAD before each
cycle" step in `src/cycle.ts:499-507`. Each cycle starts from
the current `bot/work` HEAD and adds new commits on top. With
`auto_merge: true`, master fast-forwards every cycle as today
— `bot/work` and master stay aligned. With `auto_merge: false`,
`bot/work` accumulates verified-cycle commits across the
session. Master is unchanged until human merge.

**Pros.**
- **Smallest dispatcher change.** Just delete the reset block;
  the rest of the safety machinery already protects against
  unmerged-loss because there's nothing destructive happening.
- **Cycle N+1 sees cycle N's tasks.json update naturally** —
  the engineer reads the worktree's view of `bot/work`, which
  now includes cycle N's work.
- **Single branch for human review** — `git diff master..bot/work`
  shows everything the bot did in the session.

**Cons.**
- **Cycle atomicity weakens slightly.** A cycle that passes the
  verification gate but introduces a regression that ONLY
  manifests in cycle N+1's verification still poisons the
  accumulator. Specifically: cycle N adds a function with a
  subtle bug; cycle N's verification (which only runs the
  Engineer's claimed tests) doesn't catch it; cycle N+1
  imports that function and its verification fails — but
  cycle N's commit is already on `bot/work`, so the
  rollback only undoes cycle N+1, not the underlying cause.
- **Long-lived `bot/work` divergence from master** can cause
  merge conflicts when the user finally merges, especially if
  there's been parallel master work.

#### (b) Per-cycle branches — fresh `bot/cycle-<id>` each time

**How it works.** Each cycle creates `bot/cycle-<id>` from
master at cycle start, the engineer worktrees on it, and the
branch lives on after the cycle. With `auto_merge: true`,
the dispatcher merges the branch into master and deletes the
branch. With `auto_merge: false`, the branch stays around for
human review. `bot/work` as a concept goes away (or becomes
deprecated alias of "the most recent bot/cycle-<id>").

**Pros.**
- **Maximal cycle atomicity.** Each cycle is a fully isolated
  branch from master. A bad cycle can't affect future cycles
  because future cycles don't start from it.
- **Excellent audit surface.** Every cycle is its own branch;
  `git diff master..bot/cycle-20260418112438_fcsb` shows
  exactly what cycle X did, no archaeology.
- **Trivial rollback.** Delete the branch.

**Cons.**
- **Cycle N+1 doesn't see cycle N's tasks.json update.**
  Without the previous cycle's commits visible, the engineer
  re-picks the same pending task. To fix, either:
  (i) the dispatcher updates tasks.json on master between
  cycles (a small "tasks-only" merge), or
  (ii) cycle N+1's branch is created from "master + previous
  bot/cycle-* branches" rather than just master.
  Both add complexity.
- **Branch proliferation.** A 50-cycle session leaves 50
  bot/cycle-* branches. Cleanup story needed.
- **Larger code change.** Every place that hardcodes
  `bot/work` (engineer_command.sh in projects, various tests)
  has to be updated.

#### (c) Per-cycle branches with periodic batch-merge to a "verified" trunk

**How it works.** Hybrid of (a) and (b). Each cycle gets a
`bot/cycle-<id>` branch (atomicity). After verification, if
the cycle's predecessor cycles haven't yet been merged to a
`bot/verified` trunk (by the user or automation), the
dispatcher fast-forwards `bot/verified` to include this
cycle's work. Cycle N+1 starts from `bot/verified` (so it
sees N's tasks.json). Master only updates on human merge or
auto_merge=true.

**Pros.**
- Atomicity per cycle (branches stay).
- Cycle N+1 sees N's work via bot/verified.
- Master is gated cleanly behind human review of bot/verified.

**Cons.**
- **Three branches in play** (master, bot/verified,
  bot/cycle-*) — more concepts than (a) or (b) alone.
- The "bot/verified" name is a soft promise: it's only
  verified per-cycle, not as an integrated whole.

### Recommendation: ship (a) first, design (c) later

**Implement (a) in gs-177** — it solves the immediate user
constraint with the smallest possible change. The cons of (a)
(weakened cycle atomicity if there's a cross-cycle regression)
are real but manageable: in practice the failure mode is rare
on bounded scaffolding tasks (the bulk of what a non-dogfood
bot does), and when it does fire, the user is reviewing the
bot/work branch as a whole anyway and can reject it.

**Capture (c) as gs-179 (P3)** — a future architectural
refinement. Introduce when there's evidence that (a)'s
cross-cycle-regression risk is biting in practice. Until
then, the extra concept of bot/verified buys complexity
without measured value.

**Do NOT pursue (b) standalone.** The "tasks.json doesn't
propagate" problem in (b) is a real semantic gap that adds
either a fragile "tasks-only merge" or a complicated branch-
chain — both worse than (a)'s simplicity or (c)'s explicit
accumulator.

### Open questions for gs-177 implementation

1. **Should the dispatcher commit a session-end snapshot to
   `bot/work`?** Today's session-end leaves PROGRESS.jsonl
   uncommitted in GS's tree (gs-178 added a workaround). A
   complementary improvement would be: at session end, the
   dispatcher commits all session PROGRESS.jsonl appends
   into a single "session-end audit" commit on master (since
   GS itself runs as a project where master IS what the user
   sees). Out of scope for gs-177 but worth threading.
2. **Branch naming for non-dogfood projects after (a) ships.**
   `bot/work` as the accumulator is fine. Should the
   dispatcher rename it to `bot/<session-id>` so each session's
   work is a discrete branch? Probably not — adds complexity,
   and `bot/work` is already a recognizable convention.
3. **Migration for projects already using auto_merge: true.**
   No change — auto_merge=true already makes master and
   bot/work converge after each cycle, so dropping the reset
   step is a no-op for that path.

### Definition-of-done for gs-177

- `src/cycle.ts:499-507` reset block becomes conditional on
  `auto_merge: true` (or removed entirely if the
  branch-already-at-master invariant holds for that case).
- The "bot/work N commits ahead of HEAD" guard at
  `src/cycle.ts:467-497` becomes a soft warning when
  `auto_merge: false` (instead of an abort), or is removed
  in that branch.
- New test covers a multi-cycle session with `auto_merge:
  false` chaining cleanly through 3+ cycles.
- A test verifies cycle N+1's engineer sees cycle N's
  tasks.json updates (the "successor sees predecessor" semantic).
- DESIGN.md §v5 is referenced in the gs-177 commit message.

## v6 — Parallel worktrees / multi-project concurrent cycles (2026-04-18, Phase 4)

**Status:** ✓ shipped 2026-04-18 afternoon.
  - gs-185 (picker returns N) — `src/dispatcher.ts` `pickNextProjects`
  - gs-186 (session.ts parallel loop) — opt-in via
    `dispatcher.max_parallel_slots > 1`; round-based strict-wait
  - gs-187 (per-provider reviewer semaphore) — `src/reviewer.ts`
    `withReviewerSemaphore`; defaults claude=∞, openrouter=2,
    ollama=1, env-overridable
  - gs-188 (observability) — `parallel_efficiency` in
    `session_complete`, dedicated digest section, sessions-table
    Parallel column; sequential sessions are bit-for-bit unchanged
See **docs/internal/PHASE-4-COMPLETE-2026-04-18.md** for the shipped-state
narrative. The design text below is preserved as-written because
the pattern and the open questions it called out are the right
long-run reference; the "shipped" markers above just supersede the
"queued" pointer the doc originally carried.

This section was the architectural discussion before code,
written 2026-04-18 morning after the Phase 3 closure tail
(gs-175..178) shipped and validated the bot's
single-project autonomous chaining. Phase 4's user-value
proposition is **multiplicative throughput** — N projects
cycling in parallel instead of serially — now that we have
3 registered projects (generalstaff, gamr, raybrain) with
real backlogs each.

### The bug-of-omission as observed

Today's single-project sessions: ~90s engineer + ~1s verify
+ ~10s reviewer + ~5s dispatcher overhead = ~110s wall per
cycle. With 3 projects each having pending work, a 60-min
session sequentially produces ~32 cycles maximum, distributed
by the priority×staleness picker — but in practice the
picker rotates back to the same project before others have
caught up, and verified-cycle output looks like 5-8 cycles
on the busiest project, 2-4 on each of the others.

Parallel worktrees would let three projects each run their
own cycle simultaneously: 3× the engineer parallelism, 3×
the verify parallelism, 3× the reviewer call volume — and
3× the per-minute productive output, modulo new
contention surfaces.

### Why "now":

1. **Phase 3 proved single-project autonomy works.** gs-177 +
   gs-178 close the chaining gaps; bot can now genuinely
   iterate on one project without human between-cycle
   intervention. Parallelism multiplies a working unit; it
   doesn't fix a broken one.
2. **Project count justifies the complexity.** Up through
   2026-04-18 morning, GeneralStaff was its own only
   registered project. Phase 3 added gamr; raybrain is
   bootstrapping in parallel. With ≥3 projects, sequential
   becomes the bottleneck.
3. **The worktree pattern is already per-project isolated.**
   Each project's `.bot-worktree` lives inside that project's
   own repo. No filesystem contention between projects'
   worktrees by design.

### Constraints to design against

1. **Per-project worktree isolation already holds.** No
   change needed — the design is "naturally parallel" at the
   filesystem layer.
2. **`git worktree` forbids two worktrees on the same
   branch.** This means parallelism is BETWEEN projects, not
   within a project. A single project's cycles still serialize
   through its own bot/work branch (gs-177's accumulator
   handles that path). This is a constraint, not a problem —
   serializing within a project preserves the
   successor-sees-predecessor semantic.
3. **Reviewer rate limits.** OpenRouter free tier has shared
   upstream rate limits (observed 2026-04-14: 429 on the free
   tier). With N parallel cycles all hitting OpenRouter
   simultaneously, the rate-limit wall comes faster. Mitigation
   options: (a) per-provider concurrency semaphore in
   `src/reviewer.ts`; (b) stagger cycle starts by a few
   seconds; (c) failover to a different provider in
   `GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER`. Probably need (a)
   regardless of (b) and (c).
4. **Cost: parallel × N = N × model spend.** If reviewers are
   OpenRouter, 4 parallel slots = 4× the per-cycle reviewer
   spend (still ~$0.08/min in the worst case — cheap). If
   reviewers are `claude` (subscription), N parallel = N×
   subscription quota burn — worth a config-time warning.
5. **Engineer subprocess pressure.** Each engineer cycle is a
   long-running `claude -p` subprocess (~90s in observed
   cycles). Four parallel = four concurrent Claude streams.
   Memory + token cost increases linearly. CPU usually not the
   bottleneck (engineer is mostly waiting on model output).
6. **Verify subprocess pressure.** `bun test && bun x tsc
   --noEmit` runs in the worktree's CPU. Four parallel verify
   commands = four parallel CPU loads. On a typical laptop, up
   to ~4 parallel is fine; beyond that throughput plateaus.
7. **Audit-log writes.** Each project's PROGRESS.jsonl is its
   own file. Different cycles writing to different files do
   not conflict. State files (fleet_state.json) DO need
   atomic-write coordination — already implemented. The
   per-project STATE.json + tasks.json updates land in
   different files, so no inter-project conflict.
8. **STOP file is already global.** Killing the global STOP
   should kill all parallel cycles in flight. Need to ensure
   the per-cycle STOP polling fires across all parallel slots.
9. **Session budget allocation.** If session budget is 60 min
   and there are 2 parallel slots, does each slot get 60 min
   wall time (i.e. parallel = throughput multiplier, not time
   multiplier) or 30 min each (parallel = budget split)?
   Almost certainly the former — parallel slots SHARE the
   same wall clock. The session ends when wall clock hits
   budget regardless of slot count.

### Three candidate designs

#### (a) Static parallelism — `dispatcher.max_parallel_slots: int` config

**How it works.** Add a `dispatcher.max_parallel_slots` field
to `projects.yaml` (default 1 = current behavior). At session
start, the picker selects up to N projects sorted by
priority×staleness score. `session.ts` runs all N cycles in
`Promise.all`, waiting for the slowest before starting the
next round of N. If fewer than N eligible projects exist
(some have empty queues, some are bot-already-running), spin
up only the available ones for that round.

**Pros.**
- Single config knob, easy to reason about.
- Trivial to disable (set to 1 → behavior reverts).
- Maps cleanly onto today's single-cycle code path —
  `runSingleCycle` is already self-contained per cycle.

**Cons.**
- Hard cap regardless of actual load. If N=4 but only 2
  projects have work, the other 2 slots sit idle (not bad,
  just suboptimal).
- Round-based — slowest cycle in a batch holds up the next
  batch's start. A 5-min cycle pairing with a 1-min cycle
  wastes 4 min of slot time waiting for the slow one.

#### (b) Dynamic parallelism — fixed slot pool, slot-as-soon-as-free

**How it works.** A persistent pool of N worker slots. Each
slot independently picks a project, runs a cycle, then loops
to pick the next available project. Slots are independent —
slot A finishing cycle 1 doesn't wait for slot B's cycle 1
before picking cycle 2. The picker takes a `currently_running:
Set<projectId>` and excludes those.

**Pros.**
- No "slowest holds up the batch" — slots fill as fast as
  they free up.
- Naturally handles uneven workloads (one project's work
  takes 3× longer than another's).

**Cons.**
- More moving parts: need a shared "currently_running"
  registry, a slot scheduler, and careful shutdown semantics
  (what happens to in-flight cycles when STOP fires or
  budget runs out mid-cycle?).
- Harder to test deterministically — slot ordering depends on
  cycle wall-clock variance.

#### (c) Per-project background processes — independent dispatcher per project

**How it works.** Each project gets its own dispatcher process,
launched at session start. Each project independently loops
through its own pickNextTask + runSingleCycle until its budget
or empty-cycles cap is reached. The `generalstaff session`
command becomes an orchestrator that spawns N project
dispatchers and waits for all to exit.

**Pros.**
- Maximum isolation: a crash in project A's dispatcher
  doesn't take down project B's.
- Each project can have its own provider config, budget, etc.
  with no cross-project coordination needed.

**Cons.**
- Significant rearchitecture — `session.ts` becomes a thin
  spawner; most of today's session logic moves into a
  per-project loop module.
- Cross-project policies (global STOP, total cost ceiling,
  fleet-wide rate limits) become harder to enforce — each
  child needs to read shared state independently.
- IPC for status reporting back to the orchestrator adds
  complexity.

### Recommendation: ship (a) first, (b) only if (a) bottlenecks

**Implement (a) in gs-185 + gs-186** — same incremental
philosophy as v5. The static-N round-based scheduler is the
smallest change that makes parallelism real, gives us
quantitative data on whether the round-based "slowest holds
up the batch" cost is meaningful in practice, and is trivial
to disable if it goes wrong.

**Capture (b) as gs-189 (P3)** — the dynamic-pool refinement
becomes worth doing only when (a)'s round-based wait is
demonstrably the bottleneck. With 2-3 projects of similar
cycle duration (which is the realistic state for now), (b)'s
benefit over (a) is small.

**Do NOT pursue (c) standalone.** The per-project-process
isolation pattern is over-architected for the current state
— GeneralStaff doesn't have crash-isolation problems serious
enough to justify the IPC cost. Revisit if and only if a
specific failure mode demands it.

### Phased implementation for the recommended path

**gs-185 (P2): the picker returns N candidates.** Modify
`pickNextProject` in `src/dispatcher.ts` to take a
`max_count: number` param (default 1, preserving current
behavior). Return up to N highest-scored projects, excluding
the `skipProjectIds` set. Add tests using existing fleet
fixtures + the new param. No `session.ts` changes yet.

**gs-186 (P1): `session.ts` runs N cycles in parallel.**
`max_parallel_slots` config field with default 1. The session
loop calls `pickNextProject(N - alreadyRunning)` and
`Promise.all` over the resulting cycles. Each cycle still
calls `runSingleCycle` unmodified — atomicity per cycle is
preserved. STOP file polling is already in `runSingleCycle`
so each parallel cycle sees STOP independently. Tests: a
two-project fixture session, asserting both cycles run and
both produce verified outcomes within the wall-clock budget.

**gs-187 (P2): per-provider concurrency semaphore.** Add a
small in-memory semaphore in `src/reviewer.ts` keyed on
provider name (default unbounded for `claude`, default 4 for
`openrouter` — heuristic; can tune). Reviewer calls acquire
before sending the HTTP request, release on response. Tests:
a synthetic 8-cycle parallel session with the semaphore
limiting OpenRouter to 2 concurrent calls correctly serializes
the reviewer step without breaking cycle parallelism.

**gs-188 (P2): observability for parallel sessions.** The
existing `session_complete` event aggregates across cycles.
With parallel cycles, the aggregation needs to capture
"effective wall-clock parallelism" — e.g.
`{cycles: 12, slots_used: 3, parallel_efficiency: 0.92}`.
The status command and digest format need light updates to
not present parallel cycles as a flat sequential list (they
will look weird in `git log` order if interleaved).

### Open questions for the v6 implementation arc

1. **Should the picker prefer to fill all slots even if it
   means picking a stale-but-low-priority project over an
   already-cycling-this-session high-priority project?** The
   priority×staleness scoring assumes serial execution. With
   N slots, you might want to fill empty slots even with low
   scores rather than leave them idle. Probably yes, but
   worth a config flag.
2. **Per-provider semaphore default for `openrouter` paid
   tier vs free tier?** Free tier needs aggressive limiting
   (~2 concurrent); paid tier is much more permissive
   (~10+). The user might not know which tier they're on.
   Probably default to the conservative (free-tier) value
   and let users opt up.
3. **What happens to the round-based scheduler when one slot
   finishes 4 minutes before the others?** Option (a)
   strictly waits; option (b) doesn't. If we ship (a) first
   and discover the wait is painful in practice, that's the
   trigger to escalate to (b). We should measure this from
   day 1 — emit a `slot_idle_time` field in `session_complete`
   so we can see cumulative idle minutes and decide whether
   the upgrade is worth it.

### External precedent (gstack + Conductor)

Worth noting before building: Garry Tan's `gstack`
(`github.com/garrytan/gstack`, noted 2026-04-18) explicitly
pairs with **Conductor** (`conductor.build`) to run "10–15
isolated Claude Code sessions in parallel, each with its own
workspace." Gstack is Tan's personal AI-assisted engineering
setup at YC-partner scale; Conductor is third-party orchestration
infrastructure. The combination ships the pattern we're
designing here in production, which confirms:

1. Parallel worktrees at the ~10× scale is real, not
   speculative — someone is shipping it.
2. Conductor's architectural choice (one workspace per
   parallel slot, filesystem isolation) matches our v6
   constraint #1 ("per-project worktree isolation already
   holds"). Our projects.yaml `project.path` is the same
   shape as their per-workspace isolation.
3. The pattern IS worth the complexity at that parallelism
   level — gstack is using it because sequential caps
   throughput at exactly the wall we identified in §v6
   "The bug-of-omission as observed".

We should NOT wrap Conductor itself (it's external
infrastructure with its own opinions). But we can steal
conviction from the pattern's existence in production and
ship (a) faster with fewer premature-optimization concerns.

### Definition-of-done for the v6 arc

- gs-185, gs-186, gs-187 land in src/.
- A new integration test simulates a 2-project parallel
  session with both `auto_merge` modes mixed (e.g.,
  generalstaff=true + gamr=false) and verifies both cycles
  land verified, both projects' bot/work behaves correctly
  per their auto_merge setting, and the session_complete
  event aggregates cleanly.
- DESIGN.md §v6 is referenced in each gs-NNN commit
  message.
- The default `max_parallel_slots` stays at 1 for backward
  compat — opt-in per project (or global) via projects.yaml.
- A documentation pass updates README.md to mention the
  parallel mode + when to enable it.

### Out of scope for v6

- Cross-machine parallelism. Phase 4 is local-machine only.
  Distributed dispatchers (one machine per worker pool) is a
  separate phase if it ever happens.
- Cross-project task dependencies (e.g. "wait for project A's
  cycle to land before starting project B's cycle"). All
  projects are independent in v6; if cross-project
  dependencies become a thing, that's its own design pass.
- Heterogeneous slot pools (e.g. "GPU-only slot for ML
  cycles"). Slots are interchangeable in v6.

---

## §v7 — Pluggable engineer providers (2026-04-20, gs-270)

Phase 7 makes the engineer half of a cycle pluggable the same way
the reviewer has been since Phase 2. Motivation in full is in
`docs/internal/PHASE-7-SKETCH-2026-04-19.md`; this section records
the landed architecture so a future session can read the delta
without chasing through both files.

### What changed

A cycle's engineer invocation was previously hardcoded to run
`project.engineer_command` as a bash string, expanding
`${cycle_budget_minutes}` into it. That command typically wrapped
`claude -p --dangerously-skip-permissions` — consuming the
operator's Claude subscription quota regardless of task shape.

v7 adds two optional fields to `ProjectConfig`:

- `engineer_provider: "claude" | "aider"` (optional, default
  "claude") — selects which provider module builds the cycle's
  command.
- `engineer_model: string` (optional) — provider-interpreted model
  override. For aider, any OpenRouter model id.

When `engineer_provider` is unset or "claude", behavior is
byte-identical to pre-v7 — `engineer_command` is run verbatim. No
migration needed for existing projects.

When `engineer_provider` is set to a non-claude value, the new
`resolveEngineerCommand(project)` function in `src/engineer.ts`
dispatches into the provider module. The provider module is
responsible for generating the full bash invocation that sets up
the `.bot-worktree`, installs dependencies, and runs the chosen
CLI with a task-picking prompt. The result is fed into the same
`spawn("bash", ["-c", command])` codepath as the claude path, so
timeout handling, log streaming, and progress events are
provider-agnostic.

### aider provider module

`src/engineer_providers/aider.ts` exports:

- `buildAiderCommand(project): string` — returns the full bash
  script body for one aider cycle.
- `buildAiderPrompt(project): string` — returns the aider
  `--message` text; factored out so the benchmark harness (gs-271)
  can test prompt shape independently.
- `DEFAULT_AIDER_MODEL = "openrouter/qwen/qwen3-coder-plus"` — the
  default when `engineer_model` is unset.

The generated bash does: ensure-branch → prune stale worktree →
create worktree on `bot/work` → cd in → stack-detected best-effort
install (bun / npm / pnpm / pip / cargo) → `aider --model X
--yes-always --auto-commits --no-analytics --no-stream --test-cmd
"<verification_command>" --auto-test --message "<prompt>"` → exit.

Stack detection is intentionally best-effort — aider can still run
against a tree with missing dependencies, and the verification
gate will catch any real break. Hardcoding a stack-per-project
would bloat `projects.yaml` without enough payoff.

Every string that crosses the bash boundary (model, branch,
project id, verification command, prompt) is wrapped in
`shellSingleQuote` so single quotes in operator-supplied values
can't escape the shell context. The security invariant from the
pre-v7 claude path (only numeric template substitution is safe
without explicit escaping) now lives in the provider module's
own escaping discipline.

### Commit model

Aider runs with `--auto-commits`, so each accepted edit block
produces a commit inside the worktree. This diverges from the
claude path (where the prompt asks for a single final commit)
but matches aider's native agent loop more naturally. The
dispatcher's diff capture (`getGitDiff(cycle_start_sha,
cycle_end_sha)`) is SHA-range-based and already handles multiple
commits correctly; rollback-on-failure
(`cycle.ts:808-831`) also works because it resets the branch
SHA regardless of how many commits sit between the endpoints.
We took the simplest approach that passed the existing tests.

### BYOK preserved

Hard Rule 8 remains intact. `OPENROUTER_API_KEY` sourcing logic
already exists in `scripts/run_session.bat` (for the reviewer);
aider reads the same env var natively so no additional credential
plumbing is required. The generated bash surfaces a loud warning
if the key is unset at invocation time — aider will fail to
authenticate, but the upstream warning saves log-reading.

### What v7 explicitly does NOT do

- **Does NOT refactor task-picking upstream.** Task selection
  still happens inside the engineer subprocess, reading
  `state/<project>/tasks.json` the same way `claude -p` does.
  The aider prompt tells aider to read the file and pick. If
  benchmark results show aider can't reliably replicate this
  behavior, a future phase may hoist task picking into GS
  itself — but v7 keeps the contract unchanged so the rollback
  path is "unset `engineer_provider`" with no other migration.
- **Does NOT auto-route tasks by complexity.** The operator
  picks the engineer per project. Per-task routing (e.g. "hard
  tasks to Claude, easy ones to Qwen") is a possible future
  optimization once we have benchmark data.
- **Does NOT benchmark or flip any managed project's default.**
  Landing v7 only makes the option available. The 10-task
  benchmark against gamr (gs-272) validates whether aider
  clears the 70%-verified-rate acceptance bar before any
  project's default changes.
- **Does NOT touch the reviewer.** Reviewer provider plumbing
  from Phase 2 is untouched. v7 is strictly engineer-side.

### Open questions for post-benchmark (gs-272)

- **Does Qwen3 Coder Plus handle TypeScript + React fluently
  enough to clear the bar?** Benchmark answers empirically.
- **Is `--auto-commits` the right call?** If aider produces
  many small commits that clutter the history, we may want
  `--no-auto-commits` + a final GS-generated commit. Defer
  until we see real output.
- **Does aider's agent loop drift the same way `claude -p`
  does on ambiguous tasks?** The reviewer catches both at the
  gate regardless of engineer, but drift patterns may inform
  the prompt shape.

## §v8 — Post-v7 architectural index (rolling, started 2026-05-01)

DESIGN.md v1-v7 captures the open architectural decisions with
rationale through engineer pluggability (2026-04-20). The
architectural moves shipped between v7 and the present each
have their own dated design / closure doc rather than a fresh
DESIGN.md section, because they were each scoped narrow enough
that the per-phase doc carried the full story without needing
the DESIGN.md ceremony. This v8 section is the index — it points
future readers at where each post-v7 architectural decision
actually lives so the rationale is recoverable from the repo
without rediscovering the per-phase doc by accident.

Future architectural moves that warrant a full DESIGN.md
section (cross-cutting concerns, load-bearing new constraints,
reversal of an earlier decision) should still get their own
v8.x or v9 entry here. Routine UX polish, deployment fixes,
and convention tweaks land in the relevant per-phase doc plus
this index, not a full new section.

### Web dashboard (Phase 6, closed 2026-04-20)

Local HTTP server (`Bun.serve`, port 3737) plus
`generalstaff serve` CLI subcommand plus shared layout +
stylesheet (foundation trio gs-267 / gs-268 / gs-269) plus
four route handlers (`/project/:id`, `/cycle/:cycleId`,
`/tail/:sessionId` SSE stream, `/inbox`). Localhost-bound;
no auth beyond 127.0.0.1.

Design rationale + sketch:
[`docs/internal/PHASE-6-SKETCH-2026-04-19.md`](docs/internal/PHASE-6-SKETCH-2026-04-19.md).
Hard Rule 2's "local UI is permitted as a viewer/controller"
relaxation (v2 §) is what unblocked this; the dashboard is a
viewer/controller, never a hosted SaaS.

### Usage-budget gate (closed 2026-04-21)

Session-level consumption cap with units (USD / tokens /
cycles), `hard-stop` or `advisory` enforcement, optional
per-project `on_exhausted: skip-project`, and
`ccusage`-backed provider readers that surface real
post-cycle consumption rather than pre-cycle estimates.

Design rationale:
[`docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md`](docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md).
Convention surface:
[`docs/conventions/usage-budget.md`](docs/conventions/usage-budget.md).
Hard Rule 8 (BYOK) plus the "user pays the API surface"
framing implied a hard cost ceiling per session was needed
once Phase 4 parallel mode could multiply spend by N; the
gate is the structural answer.

### Basecamp 4 integration (closed 2026-04-21)

First-party OAuth2 setup helper, thin TypeScript client, and
`generalstaff integrations basecamp <subcommand>` CLI surface.
Optional plumbing — the dispatcher itself does not depend on
Basecamp; a managed project's `engineer_command` can pull
Basecamp state into its own cycle prompts.

Design rationale + setup:
[`docs/integrations/basecamp.md`](docs/integrations/basecamp.md).
Pattern established here is "integrations live behind their own
CLI subcommand with their own credential plumbing; the
dispatcher never sees the provider's auth surface." Future
integrations should mirror this shape.

### AGENTS.md wizard skill (closed 2026-04-25)

Claude Code skill at `.claude/skills/agents-md-wizard/` that
runs a conversational discovery wizard producing an AGENTS.md
at project root. Type-branched question sets per project
category (heavy 8-12 questions for business / game / research /
infra; lightweight 2-3 for side-hustle / personal-tool /
nonsense; skip for no-plan-needed). Wired into
`generalstaff register` with skip-by-default; standalone via
`generalstaff plan <project>`.

Implementation lives at `.claude/skills/agents-md-wizard/SKILL.md`
plus the gs-322 / gs-323 commits. The skills-first integration
pattern means external tools don't bake into GS core; they live
alongside via portable SKILL.md artifacts.

### Multi-agent orchestration tooling (closed 2026-04-25)

Scripts at [`scripts/orchestration/`](scripts/orchestration/)
for spawning, monitoring, and routing work across parallel
Claude Code sessions. Four-tier spawn hierarchy: in-process
`Agent` subagents, opt-in Agent Teams (inter-agent messaging),
Tier 2 background `claude -p` spawns for bounded one-shot
side-quests, Tier 3 detached visible cmd windows for work
that must outlive the primary session. Inbox-injection hook
(v4) routes messages between sessions via a shared outbox
without shared state.

Tier table + design rationale:
[`scripts/orchestration/README.md`](scripts/orchestration/README.md).
Used in dogfood for parallel feature sprints across managed
projects; orthogonal to Phase 4's per-session parallel
worktrees (this is parallel sessions, not parallel cycles
inside one session).

### `gs welcome` first-run wizard (closed 2026-05-01)

Composes existing primitives (provider config writer plus
`runBootstrap` plus `runRegister` plus spawn `gs cycle` plus
audit reader) into one guided flow for non-technical
onboardees. Three steps: provider setup, project register +
auto-move `hands_off.yaml`, first verified cycle + audit
display. Light staff-officer voice; substance is plain.

Implementation: `src/welcome.ts` plus `tests/welcome.test.ts`.
Provider step detects `claude` on PATH and offers a
no-API-key subscription path for Pro / Max users. Model
prompt is a numbered-list picker per provider kind with a
recommended default and a Custom escape hatch.

Mac-dogfood pass on 2026-05-01 surfaced three friction items
(install.sh missing PATH shim, claude provider locking out
subscription auth, free-form model input) and shipped fixes
for all three within the same evening (commits `b8a62d9`,
`9593c12`, `a0b0d35`). Friction log captured in private
maintainer memory; resolution log is in the public commit
messages.

This is the Kunal-aligned "lower the day-one barrier for
non-technical CLI users" arc made concrete: the wizard is
the first non-CLI surface a new user touches, and its
friction shape is the load-bearing signal for what to build
next on the onboarding path.

### Cross-platform validation (2026-05-01)

Mac as a tested platform was settled on 2026-05-01 evening.
Earlier framing (Windows-first, WSL2 secondary, macOS / Linux
"rougher edges") reflected the absence of dogfood mileage on
non-Windows; the AGENTS.md non-goals list captured that as a
reactive-pruning entry on 2026-04-25. The 2026-05-01 fresh-Mac
dogfood pass closed the gap on the install + bootstrap +
wizard path. The "real-cycle mileage on macOS / Linux is still
lighter than Windows" framing is preserved (true) but the
"not a target" framing is gone (no longer true).

AGENTS.md reactive-pruning log appended a 2026-05-01 entry
that supersedes the OS dimension of the 2026-04-25 entry.
README "Tested configurations" section now describes the Mac
validation. CLAUDE.md "Working with this folder" section
dropped the "no executable code yet" framing (also stale; was
accurate pre-pivot through Phase 0).
