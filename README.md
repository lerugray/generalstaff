# GeneralStaff

**Open-source autonomous engineering for solo founders.**
**Your code. Your keys. Your control.**

A meta-dispatcher that runs Claude Code agents on your projects with
verification gates, hands-off lists, and full audit logs. The
principled alternative to closed-source SaaS bot platforms.

## Status

**Scaffold + Phase 0 design docs — no executable code yet.**
Originally created on 2026-04-13 as a private nightly meta-dispatcher
for Ray's local projects. **Pivoted on 2026-04-15** to an open-source
product targeting solo engineers and technical founders. See
[`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md) for the decision and
[`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md) for
the rule changes that came with it.

The catalogdna bot is the cornerstone reference implementation —
the design here generalizes what catalogdna already does well into
something other people can run on their own projects.

## Why "GeneralStaff"

Borrowed from Kurt von Hammerstein-Equord's officer typology. The
clever-industrious "general staff" handle execution and dispatch on
behalf of command — they don't make strategy, they make sure
strategy gets executed without dropping the plates.

The Hammerstein framing is also the philosophical moat against
closed-source bot platforms. Polsia and similar services ship agents
in all four quadrants of the typology, including the **stupid +
industrious** quadrant — where confident bots produce slop (false
task completions, generic marketing copy, fake data, auto-committed
obligations the user can't undo). Hammerstein's actual position was
that stupid+industrious officers must be **dismissed at once**
because they cause unbounded damage.

GeneralStaff structurally prevents the stupid+industrious quadrant
via the verification gate (Hard Rule #6), hands-off lists (Hard Rule
#5), default-off creative roles (Hard Rule #1), and the open audit
log (Hard Rule #9). **The architecture is the philosophy.**

The canonical writeup of the philosophy is at
`../catalogdna/docs/internal/AI Collaboration Principles.md` — read
it before making strategic decisions in this folder.

## Mission

Run autonomous engineering work on the user's local projects, with:

- Sequencing across multiple projects via a meta-dispatcher
- A **verification gate** (tests must pass, diff must be non-empty,
  reviewer must confirm scope match — no false "done" markings)
- File-based state (markdown + JSON in the user's project directory)
- Code that stays on the user's git, on a per-project `bot/work`
  branch — export equals `git clone`
- BYOK billing (the user pays Anthropic / OpenRouter directly; no
  platform credit system; no revenue share)
- An optional **local desktop UI** (Tauri) for control and audit
- An **open audit log** of every prompt, response, tool call, and
  diff produced by the bot
- **Hands-off lists** enforced at the Claude Code permission level

The point: harvest unattended hours into real, reviewable progress
across multiple projects, without any project getting starved or
any project producing slop. Then ship that capability as an
open-source product so other solo engineers can run it without
depending on a SaaS platform.

## Hard rules

The canonical list of all 10 Hard Rules is in
[`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md).
Summary:

1. **No creative work delegation by default.** Engineering /
   correctness only. Creative agents are opt-in plugins with
   explicit warnings.
2. **File-based state SSOT.** No databases, no SaaS orchestration,
   no GeneralStaff-the-company in the loop. Local desktop UI is
   permitted as a viewer/controller only.
3. **Sequential cycles for MVP.** Parallel worktrees come later.
4. **Auto-merge OFF by default.** Users opt in per-project after 5
   clean verification-passing cycles.
5. **Mandatory hands-off lists** at the Claude Code permission
   level. Empty list = no registration.
6. **Verification gate is load-bearing.** A cycle is not `done`
   until tests pass, diff is non-empty, and reviewer confirms scope
   match.
7. **Code ownership.** Bot only pushes to `bot/work` on the user's
   own git remote. Export = `git clone`.
8. **BYOK for LLM providers.** API-key default. Subscription
   support is opt-in personal-use only.
9. **Open audit log.** Full prompts, responses, tool calls, and
   diffs in `PROGRESS.jsonl` per cycle.
10. **Local-first.** No SaaS tier, no managed offering, no
    GeneralStaff-the-company hosting.

Existing rules cannot be relaxed without an explicit
`RULE-RELAXATION-<date>.md` log file documenting why.

## Files in this folder

- [`README.md`](README.md) — this file
- [`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md) — the strategic pivot
  to open source
- [`RULE-RELAXATION-2026-04-15.md`](RULE-RELAXATION-2026-04-15.md) —
  the formal rule changes that came with the pivot
- [`DESIGN.md`](DESIGN.md) — architecture sketch (v1 + v2 sections,
  append-only)
- [`projects.yaml.example`](projects.yaml.example) — example project
  registry entry (real `projects.yaml` is gitignored)
- [`CLAUDE.md`](CLAUDE.md) — instructions for future Claude sessions
  in this folder
- [`research-notes.md`](research-notes.md) — verbatim findings from
  background research on reference implementations (nightcrawler,
  parallel-cc, Polsia, Continuous-Claude-v3)
- [`INDEX.md`](INDEX.md) — Obsidian-friendly map of content for
  navigating the docs as a vault
- `.gitignore` — standard ignores

## What's next

Phase 0 (this conversation, 2026-04-15) is the design pass for the
open-source pivot. Phase 1 (a future session) is the sequential MVP
for catalogdna with the verification gate. Phase 4 adds the local UI
shell. Phase 7 is the public GitHub release.

Full 12-phase plan in [`PIVOT-2026-04-15.md`](PIVOT-2026-04-15.md).

## Reading the docs as an Obsidian vault

This folder is plain markdown, so it works out of the box as an
Obsidian vault. Open Obsidian → **Open folder as vault** → point at
this directory. Obsidian creates a `.obsidian/` subfolder for vault
settings.

**Cross-machine sync uses git, not OneDrive.** The folder happens
to live in a `OneDrive\Documents\` path but OneDrive sync is not
relied on — Ray moves work between his home and work PCs via git
(commit + push on one machine, pull on the other). The folder is
not yet a git repo as of 2026-04-15; once it is initialized, the
git-sync workflow applies and Obsidian's vault config can either
be committed (shared settings) or selectively gitignored
(per-machine state like `.obsidian/workspace.json`).

Start at [`INDEX.md`](INDEX.md) for the map of content. If you ever
want to stop using Obsidian, delete `.obsidian/` and the folder
reverts to a normal git/CLI workspace.
