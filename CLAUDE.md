# GeneralStaff — Project Conventions

This is the cross-project autonomous bot dispatcher that runs Claude
Code agents across the maintainer's local projects.

The project was **pivoted on 2026-04-15** from "personal nightly
meta-dispatcher" to "open-source product alternative to Polsia." See
`docs/internal/PIVOT-2026-04-15.md` for the decision and
`docs/internal/RULE-RELAXATION-2026-04-15.md` for the rule
changes that came with it. Future sessions
must read both before making structural changes.

**Maintainer extensions (Ray only).** When this repo is cloned on
Ray's machines alongside the private companion repo at
`github.com/lerugray/generalstaff-private`, that private clone lives
as a sibling directory (e.g. `../generalstaff-private/`) and its
`CLAUDE.local.md` extends this file with maintainer-specific
environment, workflow preferences, credential plumbing, and
project-stakes context. Missing on fresh clones — the public file
stands alone for contributors and readers.

@../generalstaff-private/CLAUDE.local.md

## Read first (in this order)

1. `README.md` — project overview and the new mission
2. `docs/internal/PIVOT-2026-04-15.md` — the strategic pivot from personal infra
   to open-source product
3. `docs/internal/RULE-RELAXATION-2026-04-15.md` — current Hard Rules (10 total
   after the pivot) with rationale for each change
4. `DESIGN.md` — architecture sketch (v1 + v2 sections, append-only;
   v2 was added 2026-04-15 as part of the pivot)
5. `docs/internal/research-notes.md` — verbatim findings from background research
   on nightcrawler, parallel-cc, Polsia, Continuous-Claude-v3
6. `projects.yaml.example` — the project registry schema

## Hard rules

The canonical list is in `docs/internal/RULE-RELAXATION-2026-04-15.md`. There are
**10 Hard Rules** as of 2026-04-15:

1. **No creative work delegation by default.** Bots get correctness
   work; users keep taste work. Creative agents (marketing/growth/
   support) are opt-in plugins with explicit warnings.
2. **File-based state SSOT.** *(Relaxed 2026-04-15:)* Local desktop
   UI is now permitted as a viewer/controller layer. No databases,
   no SaaS orchestration, no GeneralStaff-the-company in the loop.
3. **Sequential cycles for MVP.** Parallel worktrees come later.
4. **Auto-merge OFF by default.** Users opt in per-project after 5
   clean verification-passing cycles.
5. **Mandatory hands-off lists** at the Claude Code permission
   level. Empty list = no registration.
6. **NEW (2026-04-15): Verification gate is load-bearing.** A cycle
   is not `done` until tests pass, diff is non-empty, and reviewer
   confirms scope match.
7. **NEW (2026-04-15): Code ownership.** Bot only ever pushes to
   `bot/work` on the user's own git remote.
8. **NEW (2026-04-15): BYOK for LLM providers.** API-key default;
   subscription is opt-in personal-use only.
9. **NEW (2026-04-15): Open audit log.** Full prompts, responses,
   tool calls, and diffs in `PROGRESS.jsonl` per cycle.
10. **NEW (2026-04-15): Local-first by default.** No SaaS tier, no
    managed offering, no GeneralStaff-the-company hosting.

Read `docs/internal/RULE-RELAXATION-2026-04-15.md` for the full text and
rationale of each rule before modifying any of them. The relaxation
protocol still applies: **existing rules cannot be relaxed without
an explicit `docs/internal/RULE-RELAXATION-<date>.md` log file documenting why.**

## Working with this folder

- This is a **shipped codebase** as of v0.1.0 (2026-04-19). Bun +
  TypeScript, full test suite (1,850+ across 58 files as of
  2026-05-01), public on GitHub. Code lands routinely via the
  dispatcher itself (dogfood) and via interactive sessions for
  taste-work, architecture, and design docs. The earlier
  "planning + scaffold folder" framing was accurate pre-pivot
  and through Phase 0 (mid-April 2026); it no longer applies.
- **Architectural changes need design context first.** When the
  task is a structural shift (new subsystem, schema change,
  cross-cutting refactor), update `DESIGN.md` (append-only — v1
  at the top, v2+ below) before or alongside the code so the
  rationale is recoverable from the repo. Routine bug fixes,
  small features, test additions, and dogfood cycles do not need
  a design pass.
- Each open architecture question goes into the "Open questions"
  section of `DESIGN.md` or
  `docs/internal/RULE-RELAXATION-2026-04-15.md` §4 until it's
  answered.
- Research that informs design goes into
  `docs/internal/research-notes.md` (append with date headers —
  don't rewrite history).
- The folder is also an **Obsidian vault** — see
  `docs/internal/INDEX.md` for the map of content. The repo is
  public at `github.com/lerugray/generalstaff` as of 2026-04-20.

## Session context (persistence across machines)

The `~/.claude/projects/.../memory/` memory system is per-machine
and does not sync. **Context that needs to persist across machines
must live in the project wiki itself** (this file or a design doc
committed to the repo). The Claude Code memory directory is for
transient local state; the wiki is for anything a future session
would need to avoid expensive reconstruction.

### End-of-session Ingest obligation

The project vault (this file + `docs/internal/research-notes.md` + `DESIGN.md`
+ `docs/internal/FUTURE-DIRECTIONS-*.md` + `docs/internal/PHASE-*.md`) is an **LLM-maintained
wiki** in the pattern Karpathy formalized in
https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
(captured in `docs/internal/research-notes.md` 2026-04-17). The interactive
Claude session is the wiki's maintainer.

Before ending any working session, perform an **Ingest pass**:

1. **Review new sources** — external URLs/repos we discussed, new
   external refs Ray shared, strategic decisions we made, blockers
   we hit, architectural conclusions we reached. Anything a future
   session couldn't reconstruct from `git log` + `PROGRESS.jsonl`
   alone.
2. **Update the relevant pages** — new external refs into
   `docs/internal/research-notes.md`, new conventions into this file, new
   design decisions into `DESIGN.md` (append-only), new
   strategic direction into the relevant `docs/internal/PHASE-*.md` or
   `docs/internal/FUTURE-DIRECTIONS-*.md`.
3. **Cross-reference** — if a new note updates an old one,
   link explicitly so a future session following the old note
   sees the addendum.
4. **Flag contradictions** — if new info contradicts an old
   claim, say so plainly in the new entry; don't silently
   overwrite the old.
5. **Commit + push** — the vault only persists across machines
   via git. Unpushed updates are effectively lost.

The test is: *"would a work-PC session three weeks from now, or
a fresh Claude session tomorrow, need this to avoid expensive
reconstruction?"* If yes, commit it.

**What NOT to ingest:**
- Activity logs — `git log` already has what-when-who.
- Transient task state — that belongs in tasks.json or PROGRESS.jsonl.
- Session-specific debugging details that won't inform future work.
- Creative/taste material the user produced — not mine to
  archive without permission.

**Hands-off surfaces the Ingest pass never touches:** the full
hands-off list in `projects.yaml` applies to bot cycles but NOT
to interactive-session doc updates; however, `docs/internal/` is
hands-off by convention for both the bot and for Ingest — if
maintainer notes are wanted there, the maintainer asks
explicitly, don't proactively write.

### Task-queueing and dispatch conventions

- **Hands-off-aware task queueing.** When queueing tasks for the
  bot, check whether the task's expected file touches the
  hands-off list in `projects.yaml` (`src/safety.ts`,
  `src/reviewer.ts`, `src/prompts/`, `projects.yaml`,
  `scripts/`, design docs, etc.). If yes, mark the task
  **interactive-only at queue time** rather than discovering
  the conflict at cycle time. The bot will dutifully attempt
  the task, write good code, and then have its own verification
  gate roll the work back as a hands-off violation,
  burning a full engineer cycle (~6-13 min wall clock) for no
  net progress. The hands-off design is load-bearing; don't
  paper over it with per-task exceptions.

  **As of gs-195, `tasks.json` carries two optional fields that
  formalize this (see `src/types.ts` `GreenfieldTask`):**

  - `interactive_only: true` — bot picker skips the task entirely.
    Use for tasks whose scope is inherently interactive (touches
    `src/prompts/`, `projects.yaml`, the reviewer infrastructure,
    docs that need human voice, etc.).
  - `expected_touches: string[]` — declared paths the task will
    edit. If any element matches a hands_off pattern, the bot
    picker skips the task with a `hands_off_intersect` reason.
    Use for tasks whose scope is bot-safe but whose expected
    diff borders on hands_off territory (narrows the claim so
    the picker can verify statically).

  The filter is applied inside `greenfieldHasMoreWork` /
  `greenfieldCountRemaining` via `isTaskBotPickable`. A project
  with only interactive-only work left correctly reports
  "0 bot-pickable tasks remaining" to the dispatcher and the
  session moves on rather than trying and failing. Legacy tasks
  without either field remain bot-pickable by default (matches
  pre-gs-195 behaviour).

- **Parallel mode is opt-in (gs-186 / Phase 4).** The
  dispatcher supports running N cycles per round in parallel
  via `dispatcher.max_parallel_slots: N` in `projects.yaml`.
  The default is 1 (sequential, bit-for-bit identical to
  Phases 1-3). The design is round-based strict-wait: all
  slots in a round must finish before the next round starts.

  When to turn it on: when the fleet has ≥2 projects with real
  backlogs each and session wall-clock is the bottleneck. Don't
  turn it on just because more is more; parallel N roughly
  multiplies reviewer-step API spend by N on external providers
  (OpenRouter / paid Claude). Hard Rule 8 (BYOK) applies: the
  user pays. Start conservative: 2 slots on a 3-project fleet,
  watch `slot_idle_seconds` in the digest +
  `status --sessions` table, bump if utilization is high.

  Chaining is disabled in parallel mode; each round picks fresh
  projects. gs-187's per-provider semaphore prevents reviewer
  stampedes (OpenRouter free-tier 429s in particular); see
  `GENERALSTAFF_REVIEWER_CONCURRENCY_<PROVIDER>` below to tune
  it.

  The full Phase 4 narrative, including the decision rationale
  for defaults and the open measurement questions, lives in
  **docs/internal/PHASE-4-COMPLETE-2026-04-18.md** and **DESIGN.md §v6**.

- **Usage-budget cap is opt-in (gs-295..301 / 2026-04-21).** The
  dispatcher can cap session consumption in USD, tokens, or
  cycles via `dispatcher.session_budget` in `projects.yaml`.
  When the provider reads back consumption at or above the cap,
  the session stops with `stopReason: "usage-budget"`. Default
  is no cap (existing wall-clock behaviour preserved).

  ```yaml
  dispatcher:
    session_budget:
      max_usd: 5.00           # pick exactly one unit:
      # max_tokens: 500000     # max_usd | max_tokens | max_cycles
      # max_cycles: 10
      enforcement: hard-stop  # "hard-stop" (default) | "advisory"
      provider_source: claude-code  # optional; auto-detects
  ```

  Per-project caps can set `on_exhausted: skip-project` so one
  project hitting its cap drops from the picker without ending
  the whole session. Fleet-wide caps always break session
  (nothing to fall back to).

  Shipped provider readers (v1): `claude-code` (5-hour window,
  dollars / tokens / cycles via `ccusage/data-loader`). Stubs
  on the roadmap: `openrouter`, `anthropic-api`, `ollama`.
  Fail-open with one WARN per session when the reader can't
  return data; the cap is a ceiling, not a gate.

  Full docs at **docs/conventions/usage-budget.md**; design spec
  at **docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md**.

### Reviewer provider configuration

The verification-gate reviewer (`src/reviewer.ts`) is
provider-pluggable. The default is `claude` (uses `claude -p`
and consumes Ray's Claude subscription quota); the project also
ships first-class support for `openrouter` (Qwen3 Coder, paid
per-token but very cheap — ~$0.02/session) and `ollama` (local,
free, offline). The Hard-Rule 8 BYOK principle applies: nothing
about the reviewer is hosted, no key is shipped, every credential
is sourced from the user's own environment at launch.

**Observed cost calibration (2026-04-18):** after 22 verified
morning cycles plus a 2-cycle parallel validation run, the
maintainer's OpenRouter account had been charged ~$0.06 total
across the day. That's the data point behind the
"reviewer=openrouter keeps pressure off Claude subscription
quota" routing default. For **unattended or high-volume runs**
(overnight, long chain sessions, parallel mode where the
semaphore would otherwise stampede `claude -p`), route the
reviewer to OpenRouter; the per-session spend is a rounding
error against the subscription-quota cost of doing the same
work on Claude. Reserve `reviewer=claude` for attended
interactive sessions where the operator is actively watching
and low cycle-count means quota isn't at risk.

**Environment variables:**

- `GENERALSTAFF_REVIEWER_PROVIDER` — selects the provider.
  Values: `claude` (default), `openrouter`, `ollama`.
- `GENERALSTAFF_REVIEWER_MODEL` — optional model override;
  only meaningful for providers that expose a model knob
  (e.g. `qwen/qwen3-coder-plus` for openrouter, `qwen3:8b`
  for ollama). Providers pick a sensible default if unset.
- `GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER` — optional.
  If the primary provider returns a `[REVIEWER ERROR]`,
  the reviewer retries once using this provider (gs-090).
  Skip fallback if unset or equal to the primary.
- `OPENROUTER_API_KEY` — required when the primary or
  fallback provider is `openrouter`. No default; if unset
  when openrouter is selected, every cycle fail-safes to
  `verification_failed`.
- `OLLAMA_HOST` — optional. Defaults to
  `http://localhost:11434`. Used by the ollama reviewer
  and the pre-flight reachability check (gs-103).
- `GENERALSTAFF_REVIEWER_CONCURRENCY_<PROVIDER>` — gs-187,
  integer, optional. Overrides the per-provider semaphore
  limit used by the Phase 4 parallel session loop. Defaults:
  claude=∞, openrouter=2, ollama=1. Set to raise the cap
  (e.g. `=8` on an OpenRouter paid tier) or lower it to
  throttle. Only meaningful when `dispatcher.max_parallel_slots
  > 1` in `projects.yaml`; sequential sessions acquire at most
  one token and the limit never binds.

**Credential sourcing.** Credentials are never shipped and never
session-wide. The user supplies them via their own env or a
dotfile. The key is loaded into the bot subprocess scope only,
then discarded. `scripts/run_session.bat` encapsulates this on
Windows; Unix shells use the standard env-var approach.

**How `scripts/run_session.bat` wires it up (as of 2026-04-19
subroutine refactor).** The launcher takes two positional
args: `run_session.bat <budget_min> <provider>`. Provider
defaults to `openrouter`. The .bat:

1. Sets `GENERALSTAFF_REVIEWER_PROVIDER` from the second arg.
2. If the provider is `openrouter` and `OPENROUTER_API_KEY`
   isn't already set in the env, calls `:load_openrouter_key`
   which tries two file paths in order:
   - a. `OPENROUTER_ENV_FILE` env var (if set and file exists)
   - b. `%USERPROFILE%\.generalstaff\.env` (default fallback)
3. For each file, `findstr`-parses `OPENROUTER_API_KEY=` first,
   falls back to `OPENAI_API_KEY=` (an alternate field name
   some users standardize on).
4. If no file yielded a key, calls `:warn_openrouter_missing`
   which prints a loud warning listing the checked paths and
   the session still proceeds (every cycle will fail-safe to
   `verification_failed`).
5. Ollama and claude providers need no credential plumbing:
   ollama talks to `localhost:11434`, `claude -p` uses its
   own subscription auth.

**Why the subroutine refactor.** The pre-2026-04-19 loading
logic was nested `if (...) (...)` blocks with `for /f ... do
set` inside them. The cmd.exe parser has a delayed-expansion
quirk that made the outer warning check fire even when loading
succeeded. Observed across multiple sessions as a false-
positive alarm with no actual impact (reviewer verdicts were
coming back valid). The refactor pulls the loading into
`:load_openrouter_key` and the warning into
`:warn_openrouter_missing`, each called with `call :label` so
they execute in a fresh subroutine context without the nested-
block scoping issue.

When adding a new provider, mirror this pattern: env-var
selection in `reviewer.ts`, credential loading in the .bat
via a `call :label` subroutine (scoped to the subprocess,
never session-wide), and a clear fallback to
`verification_failed` if credentials are absent.

### Test-project constraints

When GeneralStaff needs a second registered project (to prove the
dispatcher's generality on something other than itself), the
candidate set is narrow:

- **catalogdna is GS-eligible as of 2026-04-20** (relaxation
  doc: `docs/internal/RULE-RELAXATION-2026-04-20-catalogdna.md`).
  The earlier "off-limits" constraint dated to the pre-pivot
  paranoid phase when GS hadn't been production-tested. Five days
  of GS on other projects (generalstaff dogfood, gamr, raybrain
  Phase 1, bookfinder-general bf-001..005) demonstrated the
  verification-gate + hands_off + reviewer discipline does what
  the off-limits rule was indirectly protecting against.
  catalogdna's registration defaults to **Mode B**
  (interactive-primary with GS as discipline layer — see
  `docs/internal/USE-MODES-2026-04-20.md` for the mode taxonomy),
  not Mode A bot-primary. Ray's taste authority over
  vault-finalization + any user-facing content is unchanged and
  will be encoded in the eventual hands_off list. The broader
  "confirm before suggesting" guidance for any Ray project with
  real users remains in force — this relaxation is specific to
  catalogdna, not a blanket policy change.
- **gamr is a live-project test case as of 2026-04-19.** Ray's
  old idea (~10 years ago): "Tinder for gamers, but strictly
  platonic" — matching people for gaming partners, nearby or
  remote. Originally registered 2026-04-18 as a *deliberately
  mediocre* test bench to hold product-viability constant while
  measuring the dispatcher's generality. **That framing was
  reversed on 2026-04-19** after the Claude-generated design
  turned out well and Ray observed no competing product fills
  the platonic-gamer-matching niche. New framing: gamr is a
  genuine launch candidate. Risk/return is low — basic web
  version with one cheap paid tier + ads on the free tier — and
  launching it serves dual purposes: (a) Ray's portfolio /
  career upside (per "Project stakes" above), (b) first
  real-live-project test case for GeneralStaff's Phase 7+
  validation (ties to docs/internal/UI-VISION-2026-04-19.md's dev-mode /
  live-mode split). Phased launch plan lives at
  `../gamr/LAUNCH-PLAN.md`; phase-progression architecture at
  `docs/internal/FUTURE-DIRECTIONS-2026-04-19.md`. Web version preferred over
  mobile for scaffolding simplicity. This reversal does NOT
  relax any Hard Rule — the Hammerstein principle (bots handle
  execution where industriousness compounds; commander keeps
  taste) still applies. It just means gamr now has a real
  product roadmap instead of being "shape-of-work only."
- **raybrain is bot-eligible as of 2026-04-18 evening.** Earlier
  in the day it was excluded from GeneralStaff bot sessions
  because Ray had parallel interactive work on the raybrain
  policy surface (`src/**/schema/**`, `src/**/privacy/**`,
  `src/**/policy/**`). As of raybrain commit 5003012, the
  schema and privacy patterns have been mechanically translated
  per CLAUDE.md prose rules and flipped to bot-owned (see
  `projects.yaml` note on those `hands_off` entries). raybrain
  Phase 1 shipped autonomously 2026-04-18 morning (rayb-001..005
  in one 27-min session); future Phase 2+ tasks are fair game
  for bot cycles. When launching a dedicated raybrain session,
  use `--exclude-project=generalstaff,gamr` until the ergonomic
  `--project=<id>` shortcut ships (queued as gs-214). raybrain's
  real-user profile is still solo — Ray is the only user — so
  "sensitive stage" considerations that apply to catalogdna
  don't apply here.

## Prefer existing OSS tools over custom code

Before writing a custom implementation of anything non-trivial
(parser, scheduler, embedding store, UI framework, message
queue, retrieval index, etc.), check whether a mature
open-source tool already solves the problem. If one does,
wrap it — don't rewrite it.

This is a **decision default**, not a Hard Rule. Custom code
isn't forbidden; it just has to earn its place against the
alternative. Legitimate reasons to roll custom: licence
incompatibility, the OSS tool would pull in a heavyweight
dependency tree for a thin use case, the OSS tool is
unmaintained or has known correctness bugs, or the custom
version is genuinely shorter than the integration shim.

**Why this matters in Hammerstein terms.** Writing custom code
where mature OSS exists is a concrete instance of
*industriousness without judgment* — the worst quadrant. It
looks productive (lines written, tests passing, commits
landing) but the work could have been free. The staff-officer
move is to know the catalog and pick the right tool; the
stupid-industrious move is to reimplement the catalog.

**Provider-routing corollary.** Same principle applies to LLM
provider selection. Don't burn paid API quota on work a free
local model can do, and don't burn local compute on work the
user needs the machine for. **Ollama for unattended runs
(overnight, while away); OpenRouter or Claude for attended
runs** (compute stays remote so the user's machine stays
responsive).

## Hammerstein context

GeneralStaff is named after the general-staff quadrant of Kurt von
Hammerstein-Equord's officer typology. The catalogdna project wrote
the canonical version of this framing at
`../catalogdna/docs/internal/AI Collaboration Principles.md`. Read
it before making strategic decisions in this folder — the framing
here is inherited, not invented.

The short version: industriousness without judgment is *worse* than
laziness without judgment, because the damage compounds. Bots are
naturally industrious; the dispatcher's job is to keep them aimed
at work where industriousness compounds positively (correctness
work, where "right" is well-defined) and away from work where it
compounds negatively (creative work, where the bot will produce
confident slop).

The 2026-04-15 pivot extended this from a personal-infra preference
into a public product positioning: GeneralStaff structurally
prevents the stupid+industrious quadrant via Hard Rules 1, 5, 6, 7,
and 9. The architecture *is* the philosophy.

## Critical: the per-project relationship

GeneralStaff does NOT replace per-project bots. It wraps them. The
catalogdna bot stays exactly as it is — its Phase A/B protocol, its
Chrome review loop, its `CLAUDE-AUTONOMOUS.md` instructions.
GeneralStaff's only role is to pick which project gets the next
cycle, run the verification gate, and pass through the per-project
bot's launch. Per-project bot designs evolve independently.

This means: future build sessions in this folder should focus on
the *meta-dispatcher*, the *verification gate*, and the *local UI*,
not on rewriting any per-project bot. If a per-project bot needs
improvement, that work happens in the per-project repo's
interactive session, not here.

## When in doubt

Ask Ray. This project will live for a long time and the early
architectural decisions matter more than usual. Don't guess — the
cost of asking is low and the cost of building the wrong thing is
high.
