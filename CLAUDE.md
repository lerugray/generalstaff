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
  folder is not yet a git repo as of 2026-04-15.

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
