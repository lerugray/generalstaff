# Changelog

All notable changes to GeneralStaff are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
in practice, entries are written in Ray's voice and prioritize
*why-it-shipped* over taxonomical neatness.

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
