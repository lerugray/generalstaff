# GeneralStaff — Project Conventions

This is the cross-project autonomous bot dispatcher that runs Claude
Code agents across multiple of Ray's local projects. **Currently
scaffold + Phase 0 design docs — no executable code yet.**

The project was **pivoted on 2026-04-15** from "personal nightly
meta-dispatcher" to "open-source product alternative to Polsia." See
`docs/internal/PIVOT-2026-04-15.md` for the decision and
`docs/internal/RULE-RELAXATION-2026-04-15.md` for the rule
changes that came with it. Future sessions
must read both before making structural changes.

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

- This is a **planning + scaffold folder** that is now also a
  **Phase 0 design pass** for an open-source product. Most tools
  (build systems, test suites, package managers) don't apply yet
  because there's no executable code.
- **Do NOT generate executable code without explicit Ray approval**
  — design first, build second, only after the design is reviewed.
- Each design decision goes into `DESIGN.md` (append-only — v1
  is preserved at the top, v2+ goes below).
- Each open question goes into the "Open questions" section of
  `DESIGN.md` or `docs/internal/RULE-RELAXATION-2026-04-15.md` §4 until it's
  answered.
- Research that informs the design goes into `docs/internal/research-notes.md`
  (append with date headers — don't rewrite history).
- The folder is also an **Obsidian vault** — see `docs/internal/INDEX.md` for
  the map of content. Cross-PC sync uses **git** (the folder lives
  in a OneDrive path but OneDrive sync is not relied on). The
  repo is at `github.com/lerugray/generalstaff` (private) as of
  2026-04-15 evening.

## Session context (persistence across machines)

Ray syncs between home and work PCs via git (not OneDrive). The
`~/.claude/projects/.../memory/` memory system on either machine
does NOT sync automatically — memory lives in `.claude` which is
per-machine. **Context that needs to persist across machines
must live in the project wiki itself (this file or one of the
design docs committed to the repo).**

The following context is relevant for all future GeneralStaff
sessions regardless of which machine they run on, and is
captured here specifically so git carries it between the home
and work PCs.

**Memory discipline (Ray, 2026-04-16):** the `~/.claude/projects/
.../memory/` directory is **per-machine, local-only**. It is NOT
a mirror of cross-machine context — duplication wastes context and
risks drift. The rule is:

- **Cross-machine context → this file (or another committed
  design doc).** Git carries it. Auto-loaded every session.
- **Local-only context → `~/.claude/memory/`.** E.g. things
  specific to this PC's paths, transient local state, personal
  notes that shouldn't be public. Do not put anything here that
  a work-PC session would also need.

When you're about to save a memory, ask: "would the work-PC
session need this?" If yes, save it here in CLAUDE.md (or a
committed doc) instead.

### End-of-session Ingest obligation (Ray, 2026-04-17)

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
to interactive-session doc updates; however, `docs/internal/` and
`docs/sessions/` are hands-off by convention for both the bot and
for Ingest — if session notes are ever wanted there, Ray asks
explicitly, don't proactively write.

### Ray's workflow conventions

- **Git, not OneDrive, for cross-machine sync.** The GeneralStaff
  folder lives in `OneDrive\Documents\` but OneDrive sync is not
  relied on. Ray commits + pushes on one machine, pulls on the
  other. Don't assume OneDrive handles anything.
- **Private repo at `github.com/lerugray/generalstaff`.** Push
  before switching machines.
- **Default branch is `master`**, not `main`. Ray's git
  convention. Don't rename.
- **Detached bot launches default to visible cmd windows.** When
  launching a bot session from an interactive Claude Code session
  so it survives the session closing (e.g. PowerShell
  `Start-Process` driving `scripts\run_session.bat`), leave the
  cmd window visible — Ray uses the window's presence as ambient
  confirmation that the bot is actually running. Do NOT use
  `-WindowStyle Hidden`. Detachment is handled by Start-Process
  itself regardless of window style; hiding the window sacrifices
  observability for no detachment benefit. Rationale captured
  2026-04-17 after a hidden-window launch left Ray unable to
  visually confirm the session had started.
- **Model routing:** Ray has detailed provider routing rules in
  `~/.claude/CLAUDE.md` (Gemini for summaries, OpenRouter Qwen
  for code delegation, Ollama for tiny tasks, Claude for
  high-stakes work). GeneralStaff Phase 2+ inherits these rules
  via `provider_config.yaml` per
  `docs/internal/FUTURE-DIRECTIONS-2026-04-15.md` §2.
- **Report fidelity — read the full relevant span, not just the
  tail.** When summarizing `PROGRESS.jsonl`, commit history, or
  any sequence of events for Ray, read enough of the source to
  ground the summary. Tail-only is fine when the tail is
  genuinely all that matters (e.g. "what was the last error?").
  It is NOT fine for session summaries, outcome reports, or
  "how did the overnight run go" style questions. Rationale
  captured 2026-04-18 after I reported on an overnight session
  by reading only the last ~20 log lines + last ~40 commits;
  that tail showed 3 empty-diff cycles, 2 failures, 1 success,
  so I framed it as "only one task landed". The truth — visible
  once Ray pushed back and I re-read structurally — was that all
  5 queued tasks (gs-166..gs-170) had completed; the "failures"
  were two retries on the same task, not four abandoned ones.
  Mischaracterizing the bot's actual output is expensive: Ray
  may re-queue shipped work, or tune a subsystem that isn't
  broken. When in doubt, grep structurally (every `cycle_end`
  in a time range, every commit touching a file, every state
  transition) rather than reading the last N lines. Structural
  queries scale; tail-reads lie.
- **Hands-off-aware task queueing.** When queueing tasks for the
  bot, check whether the task's expected file touches the
  hands-off list in `projects.yaml` (`src/safety.ts`,
  `src/reviewer.ts`, `src/prompts/`, `projects.yaml`,
  `scripts/`, design docs, etc.). If yes, mark the task
  **interactive-only at queue time** rather than discovering
  the conflict at cycle time. The bot will dutifully attempt
  the task, write good code, and then have its own verification
  gate roll the work back as a hands-off violation —
  burning a full engineer cycle (~6-13 min wall clock) for no
  net progress. Rationale captured 2026-04-18 after the morning
  bot batch (gs-171..gs-173) had 3 of 4 tasks structurally
  unrunnable for exactly this reason. The hands-off design is
  load-bearing; don't paper over it with per-task exceptions.
  The right move is to recognize at queue time that some tasks
  are interactive and route them accordingly.

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
  `greenfieldCountRemaining` via `isTaskBotPickable` — so a
  project with only interactive-only work left correctly reports
  "0 bot-pickable tasks remaining" to the dispatcher and the
  session moves on rather than trying and failing. Legacy tasks
  without either field remain bot-pickable by default (matches
  pre-gs-195 behaviour).

- **Parallel mode is opt-in (gs-186 / Phase 4).** The
  dispatcher supports running N cycles per round in parallel
  via `dispatcher.max_parallel_slots: N` in `projects.yaml`.
  The default is 1 (sequential, bit-for-bit identical to
  Phases 1-3). The design is round-based strict-wait — all
  slots in a round must finish before the next round starts.

  When to turn it on: when the fleet has ≥2 projects with real
  backlogs each and session wall-clock is the bottleneck.
  Don't turn it on just because more is more — parallel N
  roughly multiplies reviewer-step API spend by N on external
  providers (OpenRouter / paid Claude). Hard Rule 8 (BYOK)
  applies: the user pays. Start conservative: 2 slots on a
  3-project fleet, watch `slot_idle_seconds` in the digest +
  `status --sessions` table, bump if utilization is high.

  Chaining is disabled in parallel mode — each round picks
  fresh projects. gs-187's per-provider semaphore prevents
  reviewer stampedes (OpenRouter free-tier 429s in particular);
  see `GENERALSTAFF_REVIEWER_CONCURRENCY_<PROVIDER>` below to
  tune it.

  The full Phase 4 narrative, including the decision rationale
  for defaults and the open measurement questions, lives in
  **docs/internal/PHASE-4-COMPLETE-2026-04-18.md** and **DESIGN.md §v6**.

- **Public-facing copy gets a stop-slop pass before Ray
  reviews.** Any text meant for a public audience (launch posts,
  landing page copy, README hero sections, Twitter threads,
  anything that might show up on HN / Reddit / social feeds)
  runs through `/stop-slop` before Ray sees a v1. Modern readers
  pattern-match em-dashes, LLM cadence, and throat-clearing as
  AI slop; the stop-slop skill catches them before they land.
  Rationale captured 2026-04-19 after the first draft of
  `docs/launch-posts/polsia-alternative.md` had 6+ em-dashes
  and Ray flagged them as the modern LLM tell. The stop-slop
  pass took ~30s and lifted the score from 30/50 to 40+.

  **Exempt** (no slop-pass needed):
  - Internal design docs (`DESIGN.md`, `docs/internal/PHASE-*.md`,
    `docs/internal/research-notes.md`, `docs/internal/FUTURE-DIRECTIONS-*.md`). These
    are for future Claude sessions, not public readers.
  - `PROGRESS.jsonl` and other structured audit output.
  - Git commit messages (Co-Authored-By still required).
  - Error messages and CLI help text in code (separate
    discipline; handled by code-review rules).

  **Applies to** any managed project, not just GeneralStaff:
  gamr's landing page copy, catalogdna's public-facing blurbs,
  Retrogaze if it ever ships, etc. Ray does his own voice pass
  after the slop-pass; the slop-pass is the floor, not the
  ceiling.

- **Calibrate to Ray's availability before rushing session
  wrap-ups.** The system reminder surfaces the current date; if
  the time-of-day matters (e.g. "do you have an hour before
  work?", "is this a tomorrow thing?"), ask Ray instead of
  guessing from context clues. Rationale captured 2026-04-20
  after I assumed Ray was about to leave for work and tried to
  rush a session wrap-up when he actually had 2 hours of useful
  focus time. Cost of asking "how much time do you have?" is 5
  seconds; cost of mis-assuming is an over-packed or
  under-packed session plan.

- **Structural code decisions are Claude's call in interactive
  sessions.** When hitting a tradeoff internal to the code —
  API shape, file organization, refactor pattern, worktree
  isolation strategy, test-double approach, how to thread a
  new field through a module graph — default to making the
  call and moving. Ask only for **strategic / product**
  decisions: which features to build, user-facing copy, which
  N tasks to benchmark, when to cut a release, which project
  to register next. Rationale captured 2026-04-20 — Ray
  self-identifies as a game designer, not a programmer; asking
  him to arbitrate structural code choices both slows the
  session down and asks for judgment he's explicitly deferring.
  This is the interactive-session analog of the Hammerstein
  framing that already governs bot cycles: execution decisions
  belong to the staff officer, strategic decisions belong to
  command.

### Reviewer provider configuration

The verification-gate reviewer (`src/reviewer.ts`) is
provider-pluggable. The default is `claude` (uses `claude -p`
and consumes Ray's Claude subscription quota); the project also
ships first-class support for `openrouter` (Qwen3 Coder, paid
per-token but very cheap — ~$0.02/session) and `ollama` (local,
free, offline). The Hard-Rule 8 BYOK principle applies: nothing
about the reviewer is hosted, no key is shipped, every credential
is sourced from the user's own environment at launch.

**Observed cost calibration (Ray, 2026-04-18 afternoon):** after
22 verified morning cycles + a 2-cycle parallel validation run,
Ray's OpenRouter account had been charged **~$0.06 total** across
the day's sessions. That's the real data point behind the
"reviewer=openrouter keeps pressure off Claude subscription
quota" routing default. For **unattended or high-volume runs**
(overnight, long chain sessions, parallel mode where the
semaphore would otherwise stampede claude -p), route the
reviewer to OpenRouter — the per-session spend is a rounding
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

**Credential sourcing on Ray's machines.** The OpenRouter
key is stored in the MiroShark `.env` at
`C:\Users\rweis\OneDrive\Documents\MiroShark\.env` under the
field name `OPENAI_API_KEY` (the field name predates this
routing — don't rename it). `scripts/run_session.bat` loads
the key into the subprocess scope only; it is not written
session-wide.

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
   falls back to `OPENAI_API_KEY=` (MiroShark's field name).
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

**Ray's one-time setup.** Either:
- Set `OPENROUTER_ENV_FILE` persistently via
  `setx OPENROUTER_ENV_FILE "C:\Users\rweis\OneDrive\Documents\MiroShark\.env"`
  (new shells only; current shell won't see it).
- Or create `C:\Users\rweis\.generalstaff\.env` as a copy or
  a symlink (`mklink`) of MiroShark's `.env`. The default
  path means no env var is needed per launch.
- Or keep passing `OPENROUTER_ENV_FILE` explicitly via
  PowerShell Start-Process (`$env:OPENROUTER_ENV_FILE = "..."
  ; Start-Process ...`), as the interactive-Claude launches
  have been doing.

When adding a new provider, mirror this pattern: env-var
selection in `reviewer.ts`, credential loading in the .bat
via a `call :label` subroutine (scoped to the subprocess,
never session-wide), and a clear fallback to
`verification_failed` if credentials are absent.

### Project stakes (why this isn't just a hobby)

GeneralStaff, catalogdna, and Retrogaze are Ray's dev-adjacent
portfolio. He's primarily a game designer, currently working a
minimum wage day job, and uses these projects to build a profile
as a vibecoder and open paths to better opportunities. He
acknowledged this on 2026-04-15 evening: *"if it helps build my
profile at all, launch one of my ideas or leads to some kind of
better opportunity down the road other than my minimum wage
job, it will be worth it."*

Calibrate future sessions accordingly:

- **Shipping matters more than perfecting.** A soft-launched
  Phase 1 in public view is more valuable to Ray's career than
  a perfect Phase 5 that no one sees. When choosing between
  "ship it rougher but real" and "polish it more," default to
  the former.
- **The open-source story is load-bearing.** The GitHub presence,
  README framing, and the ability to show concrete shipped work
  all matter more than they would for a pure hobby project.
- **But the Hard Rules still matter.** Career stakes don't
  override scope discipline. The goal is real work that ships,
  not vaporware dressed up as portfolio material. The
  anti-slop architecture *is* the portfolio piece.
- **Don't treat catalogdna or Retrogaze as speculative testbeds.**
  They have real users and real stakes. Any GeneralStaff work
  against them needs to be safe and reversible, not just
  interesting.

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
  the off-limits rule was indirectly protecting against. Ray
  authorized the relaxation with the reasoning "I trust the work
  GS has been doing and organizationally it will help catalogDNA
  regardless." catalogdna's registration will default to **Mode B**
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
