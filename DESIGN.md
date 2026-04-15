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

See `research-notes.md` for verbatim findings from the background research
agent on nightcrawler, parallel-cc, Polsia, and Continuous-Claude-v3.
The top 3 design decisions there (file-based state per project,
git-as-source-of-truth verification ritual, hooks for state I/O) are
load-bearing for this design.

---

## v2 — Open-source pivot extensions (2026-04-15)

This section extends v1 above. **Nothing in v1 is removed.** The pivot
to an open-source product is documented in `PIVOT-2026-04-15.md`; the
rule changes are in `RULE-RELAXATION-2026-04-15.md`. Read those first
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
(See open question #6 in `RULE-RELAXATION-2026-04-15.md` §4.)

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

See `PIVOT-2026-04-15.md` for the full 12-phase plan with rationale.
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

See `RULE-RELAXATION-2026-04-15.md` §4 for the canonical list:

1. UI framework choice (Tauri vs. Electron vs. Bun browser tab)
2. Anthropic ToS clarification for subscription quota
3. Plugin API design for opt-in creative roles
4. Telemetry policy (default: none)
5. Distribution channel (GitHub, Homebrew, winget, npx)
6. Verification gate edge cases (no tests, noop verification)
