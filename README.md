# GeneralStaff

**Open-source autonomous engineering for solo founders.**
**Your code. Your keys. Your control.**

A meta-dispatcher that runs Claude Code agents on your projects with
verification gates, hands-off lists, and full audit logs. The
principled alternative to closed-source SaaS bot platforms.

## Status

**Scaffold + Phase 0 design docs + initialized git repo — no
executable code yet.** Originally created on 2026-04-13 as a
private nightly meta-dispatcher for Ray's local projects.
**Pivoted on 2026-04-15** to an open-source product targeting
solo engineers and technical founders. See
[`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md) for the decision,
[`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md)
for the rule changes, and
[`PHASE-1-PLAN-2026-04-15.md`](PHASE-1-PLAN-2026-04-15.md) for
the concrete implementation plan the next build session will
execute.

The catalogdna bot is the cornerstone reference implementation —
the design here generalizes what catalogdna already does well
into something other people can run on their own projects.

## Why "GeneralStaff"

Borrowed from Kurt von Hammerstein-Equord's officer typology. The
clever-industrious "general staff" handle execution and dispatch
on behalf of command — they don't make strategy, they make sure
strategy gets executed without dropping the plates.

The Hammerstein framing is also the philosophical moat against
closed-source bot platforms. Polsia and similar services ship
agents in all four quadrants of the typology, including the
**stupid + industrious** quadrant — where confident bots produce
slop (false task completions, generic marketing copy, fake data,
auto-committed obligations the user can't undo). Hammerstein's
actual position was that stupid+industrious officers must be
**dismissed at once** because they cause unbounded damage.

GeneralStaff structurally prevents the stupid+industrious quadrant
via the verification gate (Hard Rule #6), hands-off lists (Hard
Rule #5), default-off creative roles (Hard Rule #1), and the open
audit log (Hard Rule #9). **The architecture is the philosophy.**

The canonical writeup of the philosophy is at
`../catalogdna/docs/internal/AI Collaboration Principles.md` —
read it before making strategic decisions in this folder.

## Mission

Run autonomous engineering work on the user's local projects,
with:

- Sequencing across multiple projects via a meta-dispatcher
- A **verification gate** (tests must pass, diff must be
  non-empty, reviewer must confirm scope match — no false "done"
  markings)
- File-based state in GeneralStaff's own directory (NOT inside
  managed projects — cross-project contamination is
  architecturally impossible)
- Code that stays on the user's git, on a per-project `bot/work`
  branch — export equals `git clone`
- BYOK billing (the user pays Anthropic / OpenRouter directly;
  no platform credit system; no revenue share)
- An optional **local desktop UI** (Tauri) for control and audit
- An **open audit log** of every prompt, response, tool call,
  and diff produced by the bot
- **Hands-off lists** enforced per project

The point: harvest unattended hours into real, reviewable
progress across multiple projects, without any project getting
starved or any project producing slop. Then ship that capability
as an open-source product so other solo engineers can run it
without depending on a SaaS platform.

## Who this is for

GeneralStaff is **neutral on project motivation**. It runs
whatever you point it at — a commercial SaaS, a research tool,
an art project, a satirical anti-startup, a personal productivity
stack, a community-organizing tool, an open-source contribution
pipeline, a blog only four people read, a fake company that
exists to make a point. The dispatcher has no opinion about what
your project *is*; it just runs the correctness work on what you
tell it.

Polsia assumes you want to build a profitable SaaS. GeneralStaff
doesn't care what you're building. **Bring your own imagination;
the tool runs the execution.**

This is a deliberate design choice, not an omission. LLMs asked
for "a startup idea" return the mode of their training
distribution, which is generic SaaS — that's why every
Polsia-built company looks the same. GeneralStaff's answer is
that the imagination is yours; the tool is a GM, not a writer.
GMs don't write the players' characters; they run the rules.

Note that Hard Rule #1 (no creative delegation by default) still
holds. Running a non-SaaS project doesn't mean the bot writes
the satire or the research findings for you — the bot still does
correctness work (tests, infra, pipelines, bug grinding); you
write the creative part. The tool is neutral on **motivation**,
not on **quadrant**.

## Hard rules

The canonical list of all 10 Hard Rules is in
[`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md).
Summary:

1. **No creative work delegation by default.** Engineering /
   correctness only. Creative agents are opt-in plugins with
   explicit warnings.
2. **File-based state SSOT.** No databases, no SaaS
   orchestration, no GeneralStaff-the-company in the loop. Local
   desktop UI is permitted as a viewer/controller only.
3. **Sequential cycles for MVP.** Parallel worktrees come later.
4. **Auto-merge OFF by default.** Users opt in per-project after
   5 clean verification-passing cycles.
5. **Mandatory hands-off lists.** Empty list = no registration.
6. **Verification gate is load-bearing.** A cycle is not `done`
   until tests pass, diff is non-empty, and reviewer confirms
   scope match.
7. **Code ownership.** Bot only pushes to `bot/work` on the
   user's own git remote. Export = `git clone`.
8. **BYOK for LLM providers.** API-key default. Subscription
   support is opt-in personal-use only.
9. **Open audit log.** Full prompts, responses, tool calls, and
   diffs in `PROGRESS.jsonl` per cycle.
10. **Local-first.** No SaaS tier, no managed offering, no
    GeneralStaff-the-company hosting.

Existing rules cannot be relaxed without an explicit
`RULE-RELAXATION-<date>.md` log file documenting why.

## Files in this folder

**Start here:**

- [`README.md`](README.md) — this file
- [`CLAUDE.md`](CLAUDE.md) — instructions + session context for
  future Claude sessions (cross-machine stakes + workflow
  conventions)
- [`INDEX.md`](INDEX.md) — Obsidian-friendly map of content

**Phase 0 pivot (2026-04-15):**

- [`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md) — the strategic
  pivot from personal infra to open-source product
- [`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md)
  — the rule changes that came with the pivot (§5 has the 6
  resolved-same-day decisions)

**Architecture:**

- [`DESIGN.md`](DESIGN.md) — architecture sketch (v1 + v2
  sections, append-only; v2 has the Phase 1 spec)
- [`projects.yaml.example`](projects.yaml.example) — project
  registry schema reference

**Phase 1 implementation plan (ready for next build session):**

- [`PHASE-1-PLAN-2026-04-15.md`](PHASE-1-PLAN-2026-04-15.md) —
  concrete Phase 1 plan (wraps catalogdna's `run_bot.sh`, state
  in GeneralStaff's own dir, open-source-shaped abstractions)
- [`PHASE-1-RESOLUTIONS-2026-04-15.md`](PHASE-1-RESOLUTIONS-2026-04-15.md)
  — answers to the 5 open questions from the plan (work
  detection, Reviewer prompt template, concurrent-run detection,
  test window, state directory location)
- [`PHASE-1-SKETCH-2026-04-15.md`](PHASE-1-SKETCH-2026-04-15.md)
  — superseded original sketch (historical)

**Forward-looking:**

- [`UI-VISION-2026-04-15.md`](UI-VISION-2026-04-15.md) —
  kriegspiel / command-room UI theme for Phase 5.5+
- [`FUTURE-DIRECTIONS-2026-04-15.md`](FUTURE-DIRECTIONS-2026-04-15.md)
  — end-of-session chat capture: simulation / Kriegspiel mode
  (Phase 12+), multi-provider LLM routing (Phase 2+),
  budget-per-bot with spend guards (Phase 10+), "bring your own
  imagination" framing, Retrogaze as preferred Phase 3 second
  project, market observation

**Background:**

- [`research-notes.md`](research-notes.md) — verbatim findings
  from background research on reference implementations
  (nightcrawler, parallel-cc, Polsia, Continuous-Claude-v3)
- `.gitignore` — standard ignores (including
  `.claude/settings.local.json`, Obsidian workspace state)

## What's next

Phase 0 (2026-04-15) is **complete** — design docs, rule
relaxations, Phase 1 plan + resolutions, git repo initialized
and pushed. Phase 1 (next build session) is the sequential MVP
for catalogdna with the verification gate. Phase 4 adds the
local UI shell. Phase 7 is the public GitHub release.

Full 12-phase plan in
[`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md).

**First test cycle target:** Thursday 2026-04-16 night (Ray
working from home Friday, so tomorrow night is the most viable
window before the weekend).

## Reading the docs as an Obsidian vault

This folder is plain markdown, so it works out of the box as an
Obsidian vault. Open Obsidian → **Open folder as vault** → point
at this directory. Obsidian creates a `.obsidian/` subfolder for
vault settings (per-machine state like `.obsidian/workspace.json`
is gitignored; shared settings can be committed).

**Cross-machine sync uses git, not OneDrive.** The folder lives
in a `OneDrive\Documents\` path but OneDrive sync is not relied
on. The repo is at `github.com/lerugray/generalstaff` (private).
Ray commits + pushes on one machine, pulls on the other.

Start at [`INDEX.md`](INDEX.md) for the map of content. If you
ever want to stop using Obsidian, delete `.obsidian/` and the
folder reverts to a normal git/CLI workspace.
