# Changelog

All notable changes to GeneralStaff are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
in practice, entries are written in Ray's voice and prioritize
*why-it-shipped* over taxonomical neatness.

## [Unreleased]

## [0.4.1] — 2026-05-14

Hotfix to v0.4.0 after the first real heartbeat smoke test surfaced
two issues:

1. `runCycle()` in `src/heartbeat/dispatch.ts` constructed the
   `bun src/cli.ts cycle` command with `--project=${project}`
   interpolated inline. Bun's `$` shell template treats that as TWO
   tokens (`--project=` literal + `${project}` quoted), which fails
   parseArgs with ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL. Fix: build
   the full `--project=X` string outside the template, interpolate
   as one token. Empirically verified.

2. The heartbeat-mode agent went off-script when its Bash call
   errored — read source files, ran diagnostic commands, started
   editing `dispatch.ts` to fix the bug itself. That's exactly the
   layer separation the heartbeat router is supposed to prevent
   (engineering happens in the cycle, with hands_off + reviewer;
   the router is upstream of that safety net). Tightened
   `scripts/heartbeat-system-prompt.md` to put hard rules at the
   top + an explicit "on Bash error, write one outbox line and
   STOP" rule. Added `--tools Bash` to the supervisor's claude
   invocation so the router literally can't Read/Edit/etc.
   Defense-in-depth.

3. Bumped supervisor's `--permission-mode` from `auto` to
   `bypassPermissions`. Auto still surfaced a tool-permission
   prompt on first Bash use during the smoke test. Router runs
   one of five known dispatcher commands; the cycle downstream has
   its own permission posture.

No breaking changes. Existing v0.4.0 users on `enabled: false`
configs see no behavior change.

### Changed

- `src/heartbeat/supervisor.ts`: launch flags tightened to
  `--permission-mode bypassPermissions --tools Bash` (with rationale
  inline in the source).
- `src/heartbeat/dispatch.ts`: `runCycle` constructs `--project=X`
  outside the bun template.
- `scripts/heartbeat-system-prompt.md`: rewritten — hard rules
  promoted to top, "stop-on-error" added, tool surface declared
  explicitly.

## [0.4.0] — 2026-05-14

v0.4.0 ships two interconnected features that emerged from a single
2026-05-14 home-PC drive session: **24/7 heartbeat-mode dispatch** (an
event-driven outer launcher that sidesteps Anthropic's 2026-06-15
`claude -p` SDK-billing carve-out) and an **optional pre-cycle
Hammerstein advisor** layer (wires the manual `h audit "<plan>"`
pattern into the dispatcher between picker and engineer). Both are
additive, opt-in, and rollback-by-disabling. 2,034 tests passing, no
breaking changes.

### Added

- **Heartbeat-mode dispatch (gs-326).** New `src/heartbeat/` module
  keeps an interactive Claude Code session alive via the Stop-hook
  contract, watches `io/inbox.jsonl` for action messages, restarts
  the child for fresh context per message (same property `-p`
  provides), bills against the regular subscription instead of the
  SDK pool. Action vocabulary: `run_cycle <project>`,
  `run_session [--max-cycles=N]`, `digest`, `status`,
  `manual <text>`. Architecture inspired by
  [Siigari/claude-heartbeat](https://github.com/Siigari/claude-heartbeat)
  (MIT, 2026-05-13); this is a TypeScript port + GS-aware action
  dispatcher.

  Launchers: `scripts/heartbeat-run.ps1` (Windows),
  `scripts/heartbeat-run.sh` (Unix). Inbox CLI:
  `bun scripts/heartbeat-inbox.ts <action> [args]`. Settings
  isolated to `scripts/heartbeat-settings.json` — passed via
  `--settings`, doesn't affect normal interactive sessions on the
  repo. Watchdog default 30 min (covers 5-15 min cycles); fsync'd
  state writes; orphan reaper; graceful shutdown.

  Coexists with existing scheduled-task dispatch; rollback is "stop
  the supervisor." Full setup, action protocol, ToS framing:
  [`docs/HEARTBEAT.md`](docs/HEARTBEAT.md).

- **Pre-cycle advisor layer (gs-327).** Optional `advisor` block on
  `ProjectConfig`. When `enabled: true`, GS shells out to the `h` CLI
  (Hammerstein) between picker and engineer with the proposed task
  plan + bounded recent-cycle history; verdict lands in
  `PROGRESS.jsonl` as `advisor_verdict` event. With `gate: true`, a
  `block` verdict skips the cycle (`cycle_skipped: advisor_gated`).

  Defaults: off (zero overhead when not configured), provider
  `hammerstein`, timeout 90s, history capped at 3 cycles
  (Hammerstein-audit recommendation). Latency: ~60s typical per
  cycle when enabled — acceptable for 10-15 min cycle work, disable
  for 30s mechanical jobs. v1 supports only `provider: hammerstein`;
  multi-provider direct routing deferred to v2.

  Pre-flight `h audit` of the advisor plan itself ran 2026-05-14
  with verdict "ship with modifications"; modifications landed
  (history cap, gate as project-level Boolean, fixed verdict schema,
  latency bound). Full setup: [`docs/ADVISOR.md`](docs/ADVISOR.md).

### Changed

- README status line bumped to v0.4.0 + 2,034 tests.
- README adds dedicated sections for heartbeat + advisor.
- `projects.yaml.example` documents the `advisor` block.
- `.gitignore` excludes `io/` (heartbeat runtime state, per-machine).

### Internals

- New `src/types.ts` additions: `AdvisorConfig`, `AdvisorVerdict`,
  `AdvisorVerdictKind`, `AdvisorProvider`. New ProgressEventType:
  `advisor_verdict`.
- New `src/advisor.ts` (advisor module, ~210 lines).
- New `src/heartbeat/{types,hook,supervisor,dispatch}.ts` (~500
  lines).
- Cycle.ts integration: ~50 new lines around step 3a; dynamic-imports
  `getRecentCycles` from state so test mocks aren't forced to enumerate
  every export.

## [0.3.0] — 2026-05-08

v0.3.0 ships the phased autonomous progression arc that was on the
v0.2.0 deferred list (Phases A → B → B+ all in this release), plus a
weak-streak circuit breaker, an inventory-audit CLI, configurable
empty-cycle limits, structured engineer task-claim plumbing, and the
contributor docs the public-launch posture needed (QUICKSTART, SECURITY,
a pre-PR checklist). 44 commits since v0.2.0, no breaking changes.

### Added

- **Phased autonomous progression — Phase B+** (2026-05-04). Three
  follow-ons to Phase B:
  - **Opt-in auto-advance.** Set `auto_advance: true` at the top of
    `ROADMAP.yaml` (sibling of `current_phase`) to have the
    session-start detector run the equivalent of `gs phase advance`
    automatically when criteria pass. Default off (preserves the
    Phase B "commander gate" by default). Emits a distinct
    `phase_auto_advanced` event so the audit log can tell auto vs.
    manual advances apart.
  - **Multi-phase rollback CLI.** New `gs phase rollback
    --project=<id> --to=<phase> [--force]` walks back to a prior
    phase, popping `completed_phases` entries until the target is
    re-opened. `--force` allows targeting a phase that's not in
    `completed_phases` (sets `current_phase` directly). Does NOT
    remove already-seeded tasks — the commander cleans those up
    via `gs task done`/`task rm` if needed. Emits `phase_rolled_back`.
  - **Tasks templates with placeholder expansion.** New
    `tasks_template:` field on phases, same shape as `tasks:` but
    string fields support `{phase_id}`, `{prev_phase}`,
    `{project_id}`, `{date}`, `{datetime}` placeholders that
    resolve at advance time. Unknown placeholders fail at
    `loadRoadmap` time (typos surface immediately). Literal
    `tasks:` and templated tasks both seed into the queue on
    advance. Lets a single roadmap declare boilerplate that adapts
    per-phase.

  Two new PROGRESS.jsonl event types: `phase_auto_advanced`,
  `phase_rolled_back`. Full reference in
  [`docs/conventions/roadmap.md`](docs/conventions/roadmap.md).
- **Phased autonomous progression — Phases A + B** (`gs phase`
  command, `gs view phase-ready` view, `state/<project>/ROADMAP.yaml`
  schema, `PHASE_STATE.json` runtime tracker, `PHASE_READY.json`
  session-start sentinel). Projects can declare phased campaigns
  upfront with per-phase goals, completion criteria, and literal
  task seeding. The dispatcher detects ready phases at session
  start; the commander still advances manually via `gs phase
  advance` (auto-advance is intentionally OFF — the design's
  "commander gate" approach). v1 evaluates `all_tasks_done` and
  `custom_check` criteria; `launch_gate` / `git_tag` /
  `lifecycle_transition` are accepted by the schema but return
  "not implemented in v1." Three new event types in PROGRESS.jsonl:
  `phase_complete`, `phase_advanced`, `phase_ready_for_advance`.
  Full schema reference in
  [`docs/conventions/roadmap.md`](docs/conventions/roadmap.md);
  original design at
  [`docs/internal/FUTURE-DIRECTIONS-2026-04-19.md`](docs/internal/FUTURE-DIRECTIONS-2026-04-19.md).
  *Why:* the dispatcher previously required a human to hand-queue
  each wave of tasks. With phased roadmaps the commander writes
  the campaign once, the dispatcher detects when criteria pass at
  session start and writes a sentinel + emits an event, then the
  commander advances at phase boundaries to seed the next wave.
  Removes the reseed driver from the critical path of long-running
  autonomy.

  CLI surface:
  - `phase init --project=<id> [--force]` — scaffold a starter
    ROADMAP.yaml.
  - `phase status --project=<id> [--json]` — show current phase
    + per-criterion pass/fail.
  - `phase advance --project=<id> [--force]` — evaluate criteria,
    advance + seed next phase tasks if pass; clears the
    PHASE_READY.json sentinel on success.
  - `view phase-ready [--json]` — list of projects with a sentinel
    file present, sorted oldest-detected first.

  Originally listed v0.3.0 deferrals (auto-advance, rollback,
  templates, dashboard rendering, advance button, LAUNCH-PLAN.md
  gate, evaluators) all landed in this release — see Phase B+ entry
  above and the dashboard / phase-evaluators entries below.

- **Phase evaluators: `launch_gate`, `git_tag`, `lifecycle_transition`**
  (closed via gs-303 / gs-304 path). The Phases A+B v1 release accepted
  these criterion types in the schema but returned "not implemented in
  v1." All three are now wired:
  - `launch_gate` reads checkbox state from `LAUNCH-PLAN.md` (per-task
    completion gate).
  - `git_tag` uses `git rev-parse` with `GIT_CEILING_DIRECTORIES` to
    check whether a specific tag exists on the project's repo.
  - `lifecycle_transition` reads the new `lifecycle:` field on
    projects.yaml entries (e.g., `pre-launch` → `live` transitions
    for projects that gate phase advancement on production status).
  *Why:* phase evaluators were the structural extension point for
  Phase B's "criteria pass → ready to advance" pattern; the v1 set
  was only `all_tasks_done` + `custom_check`, which constrained
  phase design to "did the queue empty" or "did this script exit 0."
  The new evaluators let phases gate on real product milestones
  (released, tagged, status-transitioned).
- **Dashboard `/phase` route + commander advance button.** Web
  dashboard now renders `gs view phase-ready` JSON visually and
  exposes a click-to-advance button per project, replacing the
  CLI-only Phase A+B surface. Wires the JSON view module that the
  Phase B+ dispatch already produced into the existing dashboard
  frontend.
- **Weak-streak circuit breaker** (gs-323 / gs-324). Fleet-wide
  counter for consecutive `verified_weak` (empty-diff) cycles across
  any project. Default threshold 3 — at the third consecutive
  weak cycle the session halts with stop reason `weak-streak` and
  prints a recommendation to run `gs inventory-audit`. Configurable
  via `dispatcher.weak_streak_threshold` (set 0 to disable).
  *Why:* before this gate, a starved fleet (no pickable tasks
  anywhere) would chew through a session's budget in 30-second
  empty cycles. Now the circuit trips early with a diagnostic
  hint instead of the user discovering a wasted session at the
  digest.
- **`gs inventory-audit` CLI.** New diagnostic command that scans
  every registered project's `tasks.json`, separates pickable from
  unpickable (interactive_only, hands_off-intersect, expected_touches
  conflicts), and produces a report. Pairs with the weak-streak
  circuit breaker — when the breaker trips, this is the first
  thing to run. Exposed in dashboard via `verified_weak` yellow
  status color so streak-trips are visible without inspecting logs.
- **Configurable consecutive-empty limit** (gs-292). New
  `dispatcher.max_consecutive_empty` config (default 3) and
  per-project `max_consecutive_empty` override that lets the
  empty-diff exclusion logic adapt to project shapes (a project
  that legitimately produces "no work this cycle, the build is
  pending" outcomes can raise its limit; a project where empty
  diffs almost always indicate confusion can lower its limit).
  Parallel mode honors the max of per-project effective limits in
  each round.
- **Session-local empty-diff task exclusion** (gs-290). Tasks that
  produce empty diffs are temporarily excluded from picker
  consideration for the rest of the session, preventing the picker
  from cycling through the same stuck task repeatedly. Exclusion
  resets at session end.
- **Structured engineer task-claim** (gs-291). The engineer now
  explicitly emits the `attempted_task_id` it picked up in the
  cycle prompt, surfaced on `cycle_end` events. Closes a long-
  standing observability gap where the audit log showed "engineer
  worked on something, here's the diff" without the explicit task
  ID; reviewer attribution + later digest accounting both improve.
- **Greenfield work-detection fallback** (gs-304). When a project
  has no `tasks.json` of its own, the picker falls back to the
  GS-root `tasks.json` (i.e., the dispatcher project itself can
  always cycle on its own backlog without per-project state). Fixes
  the chicken-and-egg case for fresh project registrations.
- **Per-project notification breakdown** (gs-303). Session-complete
  notifications now include per-project cycle accounting (verified /
  failed / skipped) and accurate session-tag attribution, replacing
  the v0.2.0 fleet-totals-only summary.
- **`scan-bullets-by-project-affinity` library** (gs-312, jr-003).
  Extracted from the journal-reader skill into a reusable library
  for matching free-text journal entries against project IDs by
  affinity heuristics. Used by mission-bullet integration; available
  for future GS-managed-project consumption.
- **Usage-budget integration tests** (gs-301a-e, scenarios 1-11).
  Comprehensive coverage of the v0.2.0 usage-budget gate across
  per-project vs fleet semantics, `max_usd` modes, `max_tokens`,
  `max_cycles`, validation, and rolling-window math. Closes the
  test-coverage gap on the v0.2.0 budget surface that was holding
  back confidence in unattended-run behavior.
- **`QUICKSTART.md`** at repo root — five-minute path from clone to
  first verified cycle, including verdict legend and merge workflow.
  Addresses the "where do I start" gap surfaced in external review.
- **`SECURITY.md`** at repo root — secret storage guidance, OS-level
  protection recommendations, threat model for multi-user desktops
  and CI adapters, vulnerability reporting path. Documents the
  BYOK security posture explicitly.

### Changed

- **README hero block sharpened** for HN-readiness — adversarial-
  engineering frame leads ("treats agentic AI as an adversarial
  input to your codebase"), specific failure-mode list ("mark tasks
  done when tests fail," "produce empty diffs and call them
  complete"), and a real audit-log excerpt as the proof. ~37% prose
  cut without losing claims (gs-321 stop-slop pass).
- **README "What the gate doesn't catch" section** — honesty pass
  that explicitly documents what the verification gate does not
  enforce (semantic correctness, design quality, security review).
  Pre-empts the obvious HN comment.
- **Sister projects section** reframed as registered fleet members
  rather than "things Ray also works on" — the reader sees the
  dispatcher dogfooding itself across a real portfolio.
- **README Hammerstein companion section** (gs-325) — surfaces the
  Hammerstein strategic-reasoning framework + CLI as the optional
  decision-support layer that pairs with the dispatcher (audit
  before firing, scope before drafting).
- **CONTRIBUTING.md** — removed pre-launch "private repo" framing,
  added explicit pre-PR checklist (covers verification gate
  preservation, RULE-RELAXATION-doc requirement, DESIGN.md append
  discipline, doc updates for new CLI surfaces, security flag),
  added explicit note on the maintainer's private companion-repo
  pattern so external contributors aren't confused.

### Fixed

- **Aider engineer task selection** (799416a). Aider provider was
  reading the unresolved `nextTask` placeholder from the prompt
  template instead of the pre-resolved task content, leading to
  cycles that picked up nothing or the wrong task. Fix embeds the
  pre-resolved nextTask content in the prompt directly.
- **mshook-004 cache invalidation regression test** (gs-309). Hook
  cache was not invalidating on certain file-mtime patterns; test
  coverage added to prevent regression.
- **`gs-292` test suite reconciliation with `gs-323` weak-streak**
  (release-prep fix). The gs-292 tests were written before the
  gs-323 weak-streak circuit breaker landed, and their dispatcher
  configs requested 5-7 consecutive cycles which the gs-323 default
  threshold (3) was hard-stopping. Test fixtures now set
  `weak_streak_threshold: 0` for the modes that need >3 cycles, so
  the gs-292 limit is what halts. No product behavior change.

## [0.2.0] — 2026-05-02

The post-v0.1.0-launch run. Two weeks of dogfood on top of the initial
4-day build window produced enough substantive features to warrant a
minor-version bump rather than continuing to drift the v0.1 line.

### Added

- **Usage-budget gate** (gs-296 / gs-297 / gs-298). Session-level
  consumption cap wired into the dispatcher loop. Fleet-wide and
  per-project `session_budget` config with exactly-one-unit
  validation (`max_usd` / `max_tokens` / `max_cycles`), hard-stop
  and advisory enforcement modes, and a `skip-project` option on
  per-project caps so one project exhausting its share drops off
  the picker without ending the session. Reads Claude Code's own
  5-hour session blocks via the `ccusage` library, so the gate
  reflects real spend rather than a pre-cycle estimate. Design in
  [`docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md`](docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md).
  *Why:* unattended runs without a Claude subscription / OpenRouter
  credit surprise.
- **Basecamp 4 integration** (closed 2026-04-21). First-party OAuth2
  setup helper, thin TypeScript client, and
  `generalstaff integrations basecamp auth | whoami | projects` CLI
  subcommands. Optional plumbing; the dispatcher itself does not
  depend on Basecamp. A GS-managed project can pull Basecamp state
  into its own cycle prompts. Docs in
  [`docs/integrations/basecamp.md`](docs/integrations/basecamp.md).
  *Why:* CSL ops + AMFIOG playtester feedback are real Basecamp
  state Ray wanted GS-managed projects to be able to read.
- **AGENTS.md wizard, Phase A** (closed 2026-04-25). Conversational
  discovery wizard at `.claude/skills/agents-md-wizard/` producing
  an `AGENTS.md` at project root. Type-branched question sets
  (heavy 8-12 questions for business / game / research / infra;
  lightweight 2-3 for side-hustle / personal-tool / nonsense; skip
  for no-plan-needed). Wired into `generalstaff register` with a
  skip-by-default prompt; standalone via `generalstaff plan
  <project>`. AGENTS.md is the cross-platform agent-config standard
  adopted by Claude Code, Cursor, Aider, Codex, Zed, and others, so
  the artifact gives free integration with whatever other AI tool
  the user has.
- **Multi-agent orchestration tooling** (closed 2026-04-25). Scripts
  at [`scripts/orchestration/`](scripts/orchestration/) for
  spawning, monitoring, and routing work across parallel Claude
  Code sessions. Four tiers in increasing weight: in-process
  `Agent` subagents, opt-in Agent Teams (inter-agent messaging),
  Tier 2 background `claude -p` spawns for bounded one-shot
  side-quests, Tier 3 detached visible cmd windows for work that
  must outlive the primary session. Inbox-injection hook (v4)
  routes messages between sessions via a shared outbox without
  shared state. Used in dogfood for parallel feature sprints
  across managed projects.
- **`gs welcome` first-run wizard.** Conversational 5-minute setup
  for non-technical users: numbered model-list picker (Claude /
  Gemini / Aider / Codex), provider auto-detect, optional
  initial-cycle dry-run, `--skip-cycle` flag for sessions where the
  user just wants config without dispatch. Lowers the friction wall
  for users coming from "I have a project I want to point this at"
  to "I have a working dispatcher" significantly.
- **Claude subscription auth (Pro / Max).** The `claude` provider
  now supports Anthropic subscription authentication via Claude
  Code's existing token, in addition to the BYOK API-key path.
  This removes the "BYOK only" requirement for users on a paid
  Claude plan and materially expands the addressable audience
  (anyone with a Pro / Max sub can run GS without a separate API
  spend).
- **Mac / Linux session launcher** (`scripts/run_session.sh`).
  Mirrors the Windows `run_session.bat` for cross-platform parity.
  Closes the loop on the macOS / Linux dogfood gap that was
  blocking new-Mac onboarding.
- **`gs` shim install to `~/.local/bin`** (`install.sh` update).
  First-run friction fix: users no longer have to `bun run` from
  the repo dir or fiddle with PATH manually.
- **Per-machine `provider_config.yaml` gitignore** at repo root.
  Provider config is per-machine state that should not sync via git;
  the example file at `provider_config.yaml.example` is the
  canonical reference shape.

### Changed

- `loadTelegramCredentials` now respects runtime `HOME` /
  `USERPROFILE` rather than process-start values. Closes a
  cross-platform gotcha where the credentials path resolved against
  the wrong home directory in detached spawns.
- `welcome` wizard slop pass — direct conversational copy throughout,
  no AI-tells ("Notably," "Crucially," etc.) per the project's
  voice discipline.
- README hero block: surfaced subscription auth + Mac validation as
  prominent callouts.
- README em-dashes swept consistent with the project's stop-slop
  discipline (em-dashes are voice-allowed in long prose but not in
  short framing copy).
- `DESIGN.md` extended with v8 architectural index — running summary
  of the full design history through Phase 7 + post-launch additions.
- New `docs/internal/VOICE.md` codifies the editorial voice
  calibration the README + CHANGELOG + announce posts use.

### Fixed

- Self-contained test fixture for `fleet-overview` test removes the
  hidden coupling on Ray's machine state that was making the test
  pass locally and fail in CI-equivalent contexts.
- `state/{catalogdna,personal-site}/` migrated to private GS
  (gitignored from public repo) — both projects carry IP-sensitive
  state that should not ship in public clones.
- `state/{mission-employment,mission-housing}/` excluded via
  `.gitignore` for the same private-state reason (career data,
  geographic preferences, financial criteria).

### Project fleet

- 17+ managed projects in operational rotation as of v0.2.0
  (registered private + public-state). Today's PM session
  registered `twar-pc` (PC version of *The War Against Russia*,
  Crimean War strategic wargame) as the latest private-state Mode B
  project; `state/twar-pc/MISSION.md` + `tasks.json` in private GS.

### Verification stats

- Test files: 48 → 58 (+21%)
- Test definitions: ~1,628 → ~1,820 (+12%)
- All passing as of v0.2.0 tag.
- Verification gate continues to enforce the same Boolean check
  (tests pass + diff non-empty + reviewer scope match) on every
  cycle. Rejection rate over the v0.1.0 → v0.2.0 window remained
  in the same 7-10% range as the launch window — the gate is doing
  what it's supposed to, neither over- nor under-rejecting.

## [0.1.0] — 2026-04-19

Initial public release. Built across 4 calendar days (2026-04-15
scaffold + Phase 0 design → 2026-04-19 v0.1.0 tag) by the bot
running on itself. See README §"Built in 4 days" for the full
launch narrative + verification-stat breakdown.

Phases 1-7 shipped through v0.1.0:

1. Sequential MVP, independent verification gate, reviewer, open
   audit log
2. Multi-provider LLM routing (Ollama + OpenRouter + Claude),
   digest narrative, provider registry
3. Dispatcher generality across non-dogfood projects
4. Parallel worktrees opt-in (default `max_parallel_slots: 1`
   preserves Phase 1-3 behavior)
5. Visual anchor — five hand-built dashboard reference views
6. Local web dashboard (`generalstaff serve`, port 3737)
7. Pluggable engineer providers (claude / aider; OpenRouter
   Qwen 3.6+ Plus cleared 80% on 10-task benchmark) +
   creative-work opt-in (per-project + per-task gating)

Cross-platform support: Windows + macOS + Linux. AGPL-3.0
license to block SaaS-fork by closed-source competitors.
