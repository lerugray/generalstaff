# GeneralStaff — Project Conventions

This is the cross-project autonomous bot dispatcher that runs Claude
Code agents across multiple of Ray's local projects. **Currently
scaffold + Phase 0 design docs — no executable code yet.**

The project was **pivoted on 2026-04-15** from "personal nightly
meta-dispatcher" to "open-source product alternative to Polsia." See
`PIVOT-2026-04-15.md` for the decision and `RULE-RELAXATION-2026-
04-15.md` for the rule changes that came with it. Future sessions
must read both before making structural changes.

## Read first (in this order)

1. `README.md` — project overview and the new mission
2. `PIVOT-2026-04-15.md` — the strategic pivot from personal infra
   to open-source product
3. `RULE-RELAXATION-2026-04-15.md` — current Hard Rules (10 total
   after the pivot) with rationale for each change
4. `DESIGN.md` — architecture sketch (v1 + v2 sections, append-only;
   v2 was added 2026-04-15 as part of the pivot)
5. `research-notes.md` — verbatim findings from background research
   on nightcrawler, parallel-cc, Polsia, Continuous-Claude-v3
6. `projects.yaml.example` — the project registry schema

## Hard rules

The canonical list is in `RULE-RELAXATION-2026-04-15.md`. There are
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

Read `RULE-RELAXATION-2026-04-15.md` for the full text and
rationale of each rule before modifying any of them. The relaxation
protocol still applies: **existing rules cannot be relaxed without
an explicit `RULE-RELAXATION-<date>.md` log file documenting why.**

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
  `DESIGN.md` or `RULE-RELAXATION-2026-04-15.md` §4 until it's
  answered.
- Research that informs the design goes into `research-notes.md`
  (append with date headers — don't rewrite history).
- The folder is also an **Obsidian vault** — see `INDEX.md` for
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

### Ray's workflow conventions

- **Git, not OneDrive, for cross-machine sync.** The GeneralStaff
  folder lives in `OneDrive\Documents\` but OneDrive sync is not
  relied on. Ray commits + pushes on one machine, pulls on the
  other. Don't assume OneDrive handles anything.
- **Private repo at `github.com/lerugray/generalstaff`.** Push
  before switching machines.
- **Default branch is `master`**, not `main`. Ray's git
  convention. Don't rename.
- **Model routing:** Ray has detailed provider routing rules in
  `~/.claude/CLAUDE.md` (Gemini for summaries, OpenRouter Qwen
  for code delegation, Ollama for tiny tasks, Claude for
  high-stakes work). GeneralStaff Phase 2+ inherits these rules
  via `provider_config.yaml` per
  `FUTURE-DIRECTIONS-2026-04-15.md` §2.

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

- **catalogdna is off-limits as a GeneralStaff test target.** Ray
  has parallel interactive work there, and the app is at a
  sensitive stage around new-user onboarding that needs his
  steady hand. Do not propose registering catalogdna as a second
  project for GeneralStaff to manage, regardless of how
  convenient the proximity seems. This probably applies to any
  Ray project with real users — confirm before suggesting.
- **gamr is the planned scratch test project.** Ray's old idea
  (~10 years ago): "Tinder for gamers, but strictly platonic" —
  matching people for gaming partners, nearby or remote. Ray
  himself calls it a "dumb idea now." That is the point. We pick
  a deliberately mediocre idea to hold product-viability constant
  and LOW while we measure the dispatcher's generality on a
  non-self project. Do NOT drift into trying to make gamr "good"
  as a product — that defeats the experimental design. Evaluate
  gamr cycles by dispatcher behavior (verification gate rigor,
  hands-off enforcement, cycle-to-cycle compounding), not by
  whether the features are shippable. Web version preferred
  over mobile for scaffolding simplicity.

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
