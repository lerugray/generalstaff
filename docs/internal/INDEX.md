# GeneralStaff — Vault Index

Map of content for the GeneralStaff Obsidian vault. This folder is
both a project workspace and an Obsidian-compatible vault. Open it
in Obsidian via **File → Open folder as vault** and point at this
directory.

**Note on moved docs.** Some historical docs (append-only phase
closures, future-directions notes) reference files that now live
in the maintainer's private companion repo at
`github.com/lerugray/generalstaff-private`: the first-person
observation log (Hammerstein log), per-session notes
(`docs/sessions/`), launch planning, and editorial voice
calibration. Those references are preserved as historical
context; the moved docs are not required to understand the
public-facing material.

**Cross-machine sync uses git.** Commit and push on one machine,
pull on the other. The repo is public at
`github.com/lerugray/generalstaff` as of 2026-04-20.

## Start here

- [[README]] — what GeneralStaff is and the new mission
- [[PIVOT-2026-04-15]] — the 2026-04-15 strategic pivot from
  personal infra to open-source product
- [[RULE-RELAXATION-2026-04-15]] — current 10 Hard Rules with
  rationale for each change

## Architecture

- [[DESIGN]] — full architecture (v1 personal-infra design + v2
  open-source pivot extensions, both sections preserved)
- [[projects.yaml.example]] — project registry schema reference

## Forward-looking design intent

- [[UI-VISION-2026-04-15]] — kriegspiel/command-room theme for
  the eventual local UI (Phase 5.5+, captured early so the
  vision doesn't get lost)
- [[FUTURE-DIRECTIONS-2026-04-15]] — end-of-session chat capture
  of ideas that go beyond Phase 1: simulation/Kriegspiel mode
  (Phase 12+), multi-provider LLM routing (Phase 2+),
  budget-per-bot with spend guards (Phase 10+), "bring your own
  imagination" framing (applied to README), Retrogaze as
  preferred Phase 3 second project, and the market observation
  on why nobody else has built this yet. §7 addendums 3-5 added
  2026-04-18 evening: anchor-extension strategy validated for
  Phase 5 UI work, prose accessibility for non-programmer
  audiences, Phase 5 views as load-bearing marketing artifact.
- `docs/phase-5-references/` — five dashboard reference HTMLs
  built 2026-04-18 evening (fleet overview, task queue, session
  tail, dispatch detail, inbox) plus a README explaining what
  each view establishes and which CSS vocabulary carries across
  them. One Claude Design brief anchored the visual system;
  four hand-built views extended it. Read the directory README
  first for orientation.

## Implementation planning

- [[PHASE-1-PLAN-2026-04-15]] — **current Phase 1 plan**. Wraps
  catalogdna's existing `run_bot.sh`, layers independent
  verification gate + scope-match Reviewer + open audit log.
  Includes the open-source-shaped `engineer_command` /
  `verification_command` abstractions, session-level cycle
  chaining, and state-lives-in-GeneralStaff safety architecture
- [[PHASE-1-RESOLUTIONS-2026-04-15]] — **resolutions for the 5
  Phase 1 open questions**. Work-detection logic (Q1), Reviewer
  prompt template (Q2), concurrent-run detection (Q3), first
  test window Thursday 2026-04-16 (Q4), state directory location
  outside catalogdna for cross-project safety (Q5). Read
  alongside PHASE-1-PLAN before executing the next build session
- [[PHASE-1-SKETCH-2026-04-15]] — original sketch (SUPERSEDED
  2026-04-15 evening; preserved for historical context, includes
  the from-scratch architecture that the deep-dive on catalogdna
  showed was wrong-shaped)

## Phase closure narratives

- [[PHASE-1-COMPLETE-2026-04-17]] — Phase 1 sequential MVP closure
- [[PHASE-2-COMPLETE-2026-04-17]] — Phase 2 multi-provider routing
  closure (Ollama + OpenRouter + Claude, digest narrative,
  provider registry)
- [[PHASE-3-COMPLETE-2026-04-18]] — Phase 3 dispatcher generality
  closure (gamr as first non-dogfood project + 5 generality gaps
  catalogued), plus the Closure-tail addendum covering the
  morning follow-ups
- [[PHASE-4-COMPLETE-2026-04-18]] — Phase 4 parallel worktrees
  closure (gs-185..188 + gs-190/191/193/195 from the closure-tail
  shipped in the same afternoon arc). Read this for the
  max_parallel_slots opt-in, the reviewer semaphore defaults, and
  the gs-188 observability surface

## Background research

- [[research-notes]] — verbatim findings on nightcrawler,
  parallel-cc, Polsia, Continuous-Claude-v3 (append-only, dated)

## Conventions for working in this folder

- [[CLAUDE]] — instructions for future Claude sessions in this
  folder (read first list, hard rules, design protocol)

## Document conventions

- **Date-stamped decision docs** use `<TYPE>-YYYY-MM-DD.md` naming
  (e.g., `RULE-RELAXATION-2026-04-15.md`, `PIVOT-2026-04-15.md`)
- **Append-only design history**: never rewrite `DESIGN.md` v1 or
  earlier; add v2, v3, etc. sections below as the project evolves
- **Research goes into `research-notes.md`** with date headers, not
  in separate files
- **Add new docs to this index** when they are created — this file
  is the map of content for the vault

## Tags

- `#design` — DESIGN, RULE-RELAXATION
- `#strategy` — PIVOT, README
- `#research` — research-notes
- `#conventions` — CLAUDE
- `#vault` — INDEX (this file)

## How to use this vault on multiple machines

1. Both PCs need git installed and access to the same git remote
   (once the folder is initialized as a repo)
2. Both PCs need Obsidian installed (free download from obsidian.md)
3. On each PC, open Obsidian → **Open folder as vault** → point at
   the GeneralStaff folder
4. Use git to move changes between machines — commit and push on
   machine A, pull on machine B
5. Decide what to do with `.obsidian/`: typical convention is to
   commit shared vault settings (theme, enabled plugins) but
   gitignore per-machine state like `.obsidian/workspace.json` and
   `.obsidian/workspace-mobile.json`. Adjust to preference.

If you ever stop using Obsidian, delete `.obsidian/` and the folder
reverts to a normal git/CLI workspace. The actual content lives in
the `.md` files; the vault is just a viewer convention.

## Why this folder is a vault

- It's already plain markdown
- It will be under your existing git workflow once initialized
- Obsidian gives you graph view, backlinks, full-text search, and
  tag navigation across the design docs without changing anything
  about how the files are stored
- Future Claude sessions can keep editing the `.md` files
  unchanged; Obsidian and Claude Code coexist on the same source
  files

## Phase 1 code (`src/`, `tests/`, `scripts/`)

Phase 1 codebase landed 2026-04-16. Bun + TypeScript.

- `src/cli.ts` — CLI entry point (session, cycle, status, stop/start, log)
- `src/session.ts` — session loop with budget management and chaining
- `src/cycle.ts` — cycle orchestration (engineer → verify → review → audit)
- `src/dispatcher.ts` — priority × staleness picker, override file, chaining rules
- `src/engineer.ts` — subprocess wrapper for engineer_command
- `src/verification.ts` — independent verification gate (Hard Rule #6)
- `src/reviewer.ts` — spawn claude -p reviewer, parse JSON verdict
- `src/prompts/reviewer.ts` — Q2 reviewer prompt template
- `src/audit.ts` — append-only PROGRESS.jsonl writer (Hard Rule #9)
- `src/state.ts` — atomic file writes, fleet/project state
- `src/projects.ts` — projects.yaml parser + validator
- `src/safety.ts` — STOP file, clean-tree check, hands-off, concurrency detection
- `src/work_detection.ts` — Q1 chaining logic (bot_tasks.md + tasks.json)
- `src/types.ts` — shared type definitions
- `scripts/run_bot.sh` — worktree-isolated bot launcher
- `tests/` — 121+ tests across 11 files

## Phase status (2026-04-18)

- **Phase 0:** Design docs complete (2026-04-15).
- **Phase 1:** ✓ COMPLETE (2026-04-17). See
  [[PHASE-1-COMPLETE-2026-04-17]]. Sequential MVP, independent
  verification gate, reviewer pass, open audit log, all
  dogfooding green. Hundreds of verified autonomous cycles.
- **Phase 2:** ✓ COMPLETE (2026-04-17). See
  [[PHASE-2-COMPLETE-2026-04-17]]. Multi-provider routing
  (Ollama + OpenRouter + Claude), digest narrative, provider
  registry + ping subcommands. 11 core Phase 2 tasks delivered
  in a 3.5h chain=3 session window.
- **Phase 3:** ✓ COMPLETE (2026-04-18). See
  [[PHASE-3-COMPLETE-2026-04-18]]. Dispatcher generality test
  run on `gamr` (first non-dogfood managed project). 9 tasks
  landed (gs-166..174), 3 consecutive verified gamr cycles
  reached the closure criterion gs-174 specified, 5 generality
  gaps surfaced and catalogued (gs-175..178 + implicit picker
  tiebreak) for follow-up rather than inline patching per the
  Phase 3 discipline. gs-171 was the load-bearing fix:
  hardened the reviewer JSON parser against the
  false-negative-rollback failure mode (10 cycles in 24h pre-fix,
  zero in the 3-cycle gamr sample post-fix).
- **Phase 3 closure tail:** ✓ DONE (2026-04-18 morning).
  All four catalogued P1 generality gaps shipped same day.
  See PHASE-3-COMPLETE-2026-04-18.md §"Closure-tail addendum"
  for the evidence + the "minimal human interaction"
  user-experience milestone narrative.
- **Phase 4:** ✓ COMPLETE (2026-04-18 afternoon). See
  [[PHASE-4-COMPLETE-2026-04-18]]. Parallel worktrees landed
  opt-in via `dispatcher.max_parallel_slots` in projects.yaml.
  All four planned steps shipped in one arc:
  gs-185 (pickNextProjects returns up to N), gs-186 (session
  loop runs N cycles in Promise.all per round with strict-wait),
  gs-187 (per-provider concurrency semaphore keyed on
  claude/openrouter/ollama), gs-188 (parallel_efficiency +
  digest section + status --sessions Parallel column).
  Default `max_parallel_slots: 1` keeps Phase 1-3 sequential
  behaviour bit-for-bit unchanged. DESIGN.md §v6 marked
  "shipped" (previously "design only"); the gstack+Conductor
  external precedent is confirmed applicable.
- **Phase 3 closure-tail (remaining):** ✓ DONE same day.
  gs-193 fast-fail backoff (prevents retry-spin disasters),
  gs-191 hot-reload projects.yaml (mid-session registrations
  visible), gs-195 queue-time hands_off gate
  (expected_touches + interactive_only task fields),
  gs-190 Python stack detection (uv/poetry/pip + --stack on
  register). All ranked items from TODAY-2026-04-18-CLOSURE.md
  "Next-session priorities" now shipped except the P3 picker
  tiebreak (gs-184), which is interactive-only and low-value.
- **raybrain:** Third registered project (private second-brain).
  Phase 1 shipped autonomously 2026-04-18 (rayb-001..005 in
  one 27-min session, zero intervention). Phase 2 shipped
  2026-04-18 evening (rayb-006..011 in one 6/6 autonomous
  session — pydantic schema, privacy guards, ingest, wiki
  store, LanceDB retriever, CLI). See TODAY-2026-04-18-CLOSURE.md
  for the morning narrative; later work lives in git log.
- **Phase 5 (visual anchor only):** ✓ DONE 2026-04-18 evening.
  Five dashboard reference views shipped to
  `docs/phase-5-references/` as plain HTML — fleet overview
  (Claude Design anchor), task queue, session tail, dispatch
  detail, inbox (four hand-built, reusing the anchor's CSS
  vocabulary). Establishes palette, type stack, and component
  vocabulary for the eventual UI shell without committing to
  an implementation stack (Tauri, local web server, or other).
  Strategic capture in FUTURE-DIRECTIONS §7 addendums 3-5.
  The visual-anchor phase only — the dashboard shell itself
  (live read side, control surface) is still ahead.

## Next-session pickup

**Read `docs/phase-5-references/README.md` first** if Phase 5
UI work is the focus — that's the newest artifact set and
the one a fresh session on 2026-04-19+ is most likely to
need context on. It documents the five reference views and
the anchor-extension strategy behind them.

**Read PHASE-4-COMPLETE-2026-04-18.md** if Phase 4 parallel
mode is the focus — the newest shipped dispatcher architecture,
preceded Phase 5.

**Read TODAY-2026-04-18-CLOSURE.md** for the morning arc
(22 verified cycles across 3 projects, 15 generality gaps
surfaced, 5 closed, the minimal-human-interaction milestone)
if the morning work is relevant. That doc covers the morning
only; Phase 4 and Phase 5 don't appear there.
- **Phase 7:** Public GitHub release. The folder gets renamed to
  a public-facing repo at that point; this index file becomes the
  vault entry for any contributor who clones the repo and opens it
  in Obsidian.

See [[PIVOT-2026-04-15#Phased build plan revised]] for the full
12-phase plan with rationale.
