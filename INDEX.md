# GeneralStaff — Vault Index

Map of content for the GeneralStaff Obsidian vault. This folder is
both a project workspace and an Obsidian-compatible vault. Open it
in Obsidian via **File → Open folder as vault** and point at this
directory.

**Cross-machine sync uses git, not OneDrive.** The folder happens
to live in a `OneDrive\Documents\` path but OneDrive sync is not
relied on. Ray moves work between his home and work PCs via git —
commit and push on one machine, pull on the other. The repo is
at `github.com/lerugray/generalstaff` (private) as of
2026-04-15 evening.

## Start here

- [[README]] — what GeneralStaff is and the new mission
- [[PIVOT-2026-04-15]] — the 2026-04-15 strategic pivot from
  personal infra to open-source product
- [[RULE-RELAXATION-2026-04-15]] — current 10 Hard Rules with
  rationale for each change
- [[VOICE]] — editorial voice calibration for public writing
  (README, landing copy, release notes). Captures the anti-Polsia
  positioning, the Prussian/Marxist intellectual juxtaposition,
  and the human-livability thesis that connects them

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
  on why nobody else has built this yet

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

## Background research

- [[research-notes]] — verbatim findings on nightcrawler,
  parallel-cc, Polsia, Continuous-Claude-v3 (append-only, dated)

## Hammerstein logs (`docs/internal/`)

- [[Hammerstein Observations Log]] — Ray's first-person
  reflective log (append-only, hands-off for autonomous bots)
- [[Hammerstein Observations - Claude]] — Claude/bot-side
  observations (interactive sessions + future autonomous runs)

## Session history (`docs/sessions/`)

- [[2026-04-15]] — pivot session (home PC, evening, Opus 4.6).
  Phase 0 design pass, Polsia deep-dive, Phase 1 plan, all 5
  open questions resolved, future directions captured.
- [[2026-04-16]] — first build session (work PC, morning, Opus
  4.6). Phase 1 code landed, dogfooding setup, 7+ verified
  autonomous cycles, 121+ tests, 3 bugs found and fixed.
- [[2026-04-17]] — Phase 1 close + Phase 2 chain + Phase 3
  kickoff (work PC, full-day arc, Opus 4.6). Phase 1 formally
  closed, Phase 2 (reviewer pass, verification gate,
  multi-provider routing) shipped in a 3.5h chain=3 session,
  Phase 3 kicked off by attempting to register `gamr` as the
  first non-dogfood project — which surfaced the state-path
  architectural finding (gs-166..gs-170 queued for overnight).

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
- **Phase 3 (current):** Dispatcher generality — surfacing and
  closing gaps that only appear on non-dogfood projects.
  Kicked off 2026-04-17 evening by attempting to register
  `gamr` as first non-dogfood project. First architectural
  finding (inconsistent tasks.json path handling) closed by
  the overnight 2026-04-18 run (gs-166..gs-170 all verified).
  Next: harden reviewer JSON parser (gs-171, 10 observed
  false-negative rollbacks in 24h — see DESIGN.md §v4 + the
  reviewer-JSON entry in research-notes.md), then actually
  register gamr and run first non-dogfood cycle.
- **Phase 7:** Public GitHub release. The folder gets renamed to
  a public-facing repo at that point; this index file becomes the
  vault entry for any contributor who clones the repo and opens it
  in Obsidian.

See [[PIVOT-2026-04-15#Phased build plan revised]] for the full
12-phase plan with rationale.
