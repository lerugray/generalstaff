# Phase 1 Sketch — 2026-04-15

**Status:** Brief sketch, not a full plan. Captures the key
decisions for Phase 1 implementation so the next build session can
start without re-thinking. A full step-by-step `PHASE-1-PLAN.md`
should be written at the start of the next session before any code
lands.

**Phase 1 goal:** Sequential MVP — dispatcher reads `projects.yaml`,
picks catalogdna, runs Planner→Engineer→Reviewer chain on it, runs
the verification gate, writes audit log to `.generalstaff/PROGRESS.
jsonl`, sends morning digest. **catalogdna only.** Second project
comes in Phase 3.

---

## Language: Bun + TypeScript

**Why:**

- Bun gives us a single binary, fast startup, native TypeScript,
  and a built-in HTTP server (useful later for Phase 4 UI).
- The dispatcher is mostly: read JSON, write JSON, shell out to
  `claude`, parse output, run verification command, write more
  JSON. TypeScript with strict typing makes the JSON contracts
  (STATE, HANDOFF, PROGRESS entries) self-documenting.
- Single distribution path: a Bun binary works on Mac/Linux/Win
  with the same source. No Python venv ceremony, no shell
  portability issues.
- Ray's existing routing rules already lean on Bun/Node tooling.
  Familiar.

**Alternative considered:** Python. Rejected because subprocess
management for long-running `claude -p` calls is cleaner in Bun's
process API, and packaging a Python CLI for non-Python users is
more friction than necessary for a public product.

**Open:** Worth a 30-min spike before locking the choice — confirm
Bun's process API can stream `claude -p` output cleanly enough for
the live-tail UI later.

---

## CLI surface

```
generalstaff init <project-path>      # create .generalstaff/ in a project
generalstaff register <project-path>  # add to projects.yaml after init
generalstaff cycle [--project=ID]     # run one cycle, optional override
generalstaff status                   # show fleet state
generalstaff stop                     # touch STOP file
generalstaff start                    # remove STOP file
generalstaff log [--project=ID]       # tail PROGRESS.jsonl
generalstaff verify <project-id>      # run verification only (no agents)
```

`generalstaff cycle` with no flag uses the picker (priority ×
staleness, with `next_project.txt` override).

---

## File structure

```
GeneralStaff/
├── src/
│   ├── cli.ts                # entry point, command routing
│   ├── dispatcher.ts         # picker, cycle orchestration
│   ├── types.ts              # shared TS types (STATE, HANDOFF, etc.)
│   ├── agents/
│   │   ├── base.ts           # claude -p wrapper, role-scoped
│   │   ├── planner.ts        # Planner agent invocation
│   │   ├── engineer.ts       # Engineer agent invocation
│   │   └── reviewer.ts       # Reviewer agent invocation
│   ├── verification.ts       # verification gate (Hard Rule #6)
│   ├── audit.ts              # PROGRESS.jsonl writer
│   ├── state.ts              # STATE/HANDOFF/tasks read+write
│   ├── projects.ts           # projects.yaml parser + validator
│   ├── safety.ts             # STOP file, hands-off enforcement
│   └── digest.ts             # morning digest writer
├── tests/
│   └── ... (Bun's built-in test runner)
├── package.json
├── tsconfig.json
└── README.md (existing, updated for CLI usage in a later phase)
```

---

## Phase 1 build order

1. **Project bootstrap.** `package.json`, `tsconfig.json`, Bun's
   test runner config, basic CLI scaffolding (`generalstaff
   --version` works).
2. **Type definitions.** `src/types.ts` — schemas for STATE,
   HANDOFF, tasks, PROGRESS entries, projects.yaml, REVIEW. Lock
   the JSON contracts before writing logic.
3. **State module.** `src/state.ts` — read/write per-project state
   files. Include atomic-write helpers (write to tmp, rename).
4. **Projects loader.** `src/projects.ts` — parse `projects.yaml`,
   validate hands-off lists are non-empty (refuses startup if not),
   fail loudly on invalid config.
5. **Safety module.** `src/safety.ts` — STOP file checker,
   hands-off list to Claude Code permission deny rules conversion.
6. **Audit writer.** `src/audit.ts` — append-only writer for
   PROGRESS.jsonl with the schema from DESIGN.md v2. Include the
   `safety_block` event type.
7. **Agent invocation primitives.** `src/agents/base.ts` — wraps
   `claude -p` with role-scoped permissions, captures full
   prompt/response, returns a structured result.
8. **Planner / Engineer / Reviewer.** `src/agents/{planner,
   engineer,reviewer}.ts` — role-specific prompt templates and
   tool scopes.
9. **Verification gate.** `src/verification.ts` — runs
   `verification_command`, parses git diff, dispatches reviewer
   scope check. Returns `verified` / `verified_weak` /
   `verification_failed`.
10. **Dispatcher.** `src/dispatcher.ts` — picker, cycle
    orchestration, calls each module in sequence, handles failures
    with graceful exit + Telegram alert (or local digest in
    Phase 1).
11. **CLI entry point.** `src/cli.ts` — wire commands to modules.
12. **Catalogdna `.generalstaff/MISSION.md`.** Generate based on
    catalogdna's existing `CLAUDE-AUTONOMOUS.md`. One-page focused
    "what shipping looks like" doc.
13. **Dry-run on catalogdna.** Run with `--dry-run` flag (no
    actual edits, just plan + verify). Iterate until clean.
14. **First live run.** Manual trigger, supervised. Auto-merge
    OFF. Review the morning digest.
15. **Five clean cycles.** Validate the verification gate over
    a week of supervised runs before considering Phase 2 done.

---

## Open questions for Phase 1

1. **How does the Engineer agent get hands-off enforcement at the
   tool level?** Claude Code's permission deny rules are configured
   per-session via `.claude/settings.local.json` (or equivalent).
   The dispatcher needs to spawn `claude -p` with a temporary
   settings file containing the project's hands-off list as deny
   rules. **Need to verify the exact mechanism** — read Claude
   Code docs on permission rule injection at the start of Phase 1.

2. **How does GeneralStaff coexist with catalogdna's existing
   `run_bot.sh` infrastructure?** Three options:
   a. GeneralStaff replaces it for catalogdna runs (simpler, but
      breaks catalogdna's standalone bot)
   b. GeneralStaff invokes `run_bot.sh` and treats it as the
      Engineer agent (preserves standalone, less control over the
      verification gate)
   c. GeneralStaff and `run_bot.sh` coexist — different entry
      points to similar work, both write to `bot/work` branch
   
   **Lean:** option (c). catalogdna's bot keeps running standalone;
   GeneralStaff runs its own dispatcher cycles using the same
   project conventions. Two ways into the same codebase, no
   conflict because both write to `bot/work`. Confirm with Ray
   before locking.

3. **What's the `verification_command` for catalogdna?** From
   `projects.yaml.example`: `py -m pytest tests/ -q`. Need to
   confirm this is the right invocation and add a build-check if
   catalogdna has one. Read catalogdna's actual test setup at
   the start of Phase 1.

4. **Telegram morning digest.** The digest writer needs a Telegram
   bot token + chat ID. catalogdna already has a Telegram pattern
   — Phase 1 can copy that pattern, or just write digest files
   locally and skip Telegram for the first few runs.
   **Lean:** start with local digest files only; add Telegram in
   Phase 2 once the core flow is stable.

5. **Where does the dispatcher actually run?** Cron, Task
   Scheduler, .bat file, manual? Per `DESIGN.md` v1 open question
   #1, the lean was ".bat launcher possibly with Task Scheduler."
   Decide before Phase 1 wraps. For initial supervised runs, manual
   trigger is fine.

---

## Test strategy

Phase 1 is hard to unit-test exhaustively because the Engineer
agent's behavior is non-deterministic. Instead:

- **Unit tests** for `state`, `projects`, `safety`, `audit`,
  `verification` modules — pure functions over file I/O.
- **Integration test** for the dispatcher with a fake project (a
  tiny git repo with a passing test suite) and a mocked Claude
  invocation that returns canned responses.
- **Manual supervised runs** on catalogdna before any unattended
  operation. Five clean cycles required before enabling auto-merge
  per Hard Rule #4.

---

## Definition of done for Phase 1

- `generalstaff cycle` runs end-to-end on catalogdna without errors
- A test failure in catalogdna correctly produces a
  `verification_failed` cycle that does not get marked done
- Hands-off list violations are blocked at the Claude Code
  permission level (verified by attempting to edit a hands-off
  file in a dry run)
- `PROGRESS.jsonl` contains a complete audit trail of one cycle
  (all event types: `cycle_start`, `agent_response × 3`,
  `verification_run`, `verification_passed`, `reviewer_verdict`,
  `cycle_end`)
- Morning digest file is written with verdict + summary
- Five supervised cycles run cleanly with manual review of each

After Phase 1's definition of done is met, Phase 2 (formal
Reviewer pass with the verification gate fully integrated) can
begin.

---

**Captured:** 2026-04-15, end of pivot session
**Next action:** Open this file at the start of the next build
session and convert it into a full `PHASE-1-PLAN.md` before any
code lands. The conversion pass should resolve the 5 open
questions above and lock the `verification_command` for
catalogdna.
