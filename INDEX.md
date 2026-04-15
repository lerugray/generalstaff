# GeneralStaff — Vault Index

Map of content for the GeneralStaff Obsidian vault. This folder is
both a project workspace and an Obsidian-compatible vault. Open it
in Obsidian via **File → Open folder as vault** and point at this
directory.

**Cross-machine sync uses git, not OneDrive.** The folder happens
to live in a `OneDrive\Documents\` path but OneDrive sync is not
relied on. Ray moves work between his home and work PCs via git —
commit and push on one machine, pull on the other. (The folder is
not yet a git repo as of 2026-04-15; once it is initialized, this
workflow applies.)

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

## Implementation planning

- [[PHASE-1-SKETCH-2026-04-15]] — sketch of Phase 1 (sequential
  MVP for catalogdna with verification gate); seed for the full
  plan to be written at the start of the next build session

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

## Phase status (2026-04-15)

- **Phase 0 (current):** Design docs for the open-source pivot.
  No code yet. Adding new design files happens here.
- **Phase 1 (next):** Sequential MVP for catalogdna with
  verification gate. Will happen in a future build session.
- **Phase 7:** Public GitHub release. The folder gets renamed to
  a public-facing repo at that point; this index file becomes the
  vault entry for any contributor who clones the repo and opens it
  in Obsidian.

See [[PIVOT-2026-04-15#Phased build plan revised]] for the full
12-phase plan with rationale.
