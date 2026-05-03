# devforge-website — Mission (GeneralStaff context, Mode B)

Public marketing site for Devforge, the desktop game-dev IDE for
Claude Code (and other AI coding CLIs). Lives at
`github.com/lerugray/devforge-website`.

Plain HTML/CSS/JS, no build pipeline. Two surfaces:
- `index.html` — primary marketing landing page
- `itch.html` — itch.io listing mirror (kept in sync with the
  main devforge repo's `docs/ITCH_LISTING.md`)

Plus `ROADMAP_PUBLIC.md` for what's coming, and per-version
update briefs (`BRIEF_VxxxUPDATE.md`) handed to the site as each
new app version ships.

Registered in GeneralStaff 2026-05-03 as a **public-state Mode B
project**. Public GitHub remote at
`github.com/lerugray/devforge-website`.

## GS's role

Tracks website-version-vs-app-version drift. The Devforge app
releases on its own cadence; the website sometimes lags by a
release or two. GS captures the delta as a task so a stale site
doesn't quietly point users at a version that no longer exists.

- `state/devforge-website/tasks.json` — version-bump + content
  tasks queue.
- `state/devforge-website/MISSION.md` — this file.
- `projects.yaml §devforge-website hands_off` — voice-bearing
  surfaces.
- `state/devforge-website/PROGRESS.jsonl` — audit trail when bot
  cycles run (none planned yet).

## Default posture

**Mode B / interactive-only.** All tasks `interactive_only: true`.
Marketing copy is voice-bearing; Ray writes the prose. The site
itself is small enough that the engineering value of bot cycles
is low — the delta per release is a few targeted edits, not a
codebase to grind through.

**`engineer_command` fail-closed.** `echo + exit 1` placeholder.
A real engineer_command never gets scaffolded unless the site
grows to a scope where bot cycles earn their keep.

**`creative_work_allowed: false`.** v0.3.x positioning copy stays
in Ray's voice. The BRIEF_VxxxUPDATE.md pattern is the canonical
handoff for what changed; Ray applies the prose pass himself.

## Update workflow

1. New Devforge app version ships (e.g., v0.3.1 on 2026-05-03).
2. Ray or a Claude session in the devforge repo drafts a
   `BRIEF_VxxxUPDATE.md` capturing the delta + what to update on
   the site.
3. Brief commits to the website repo.
4. Ray or an interactive Claude session in the website repo
   applies the brief: updates index.html, itch.html,
   ROADMAP_PUBLIC, bumps version refs.
5. Brief moves to `brief archive/` once the site is current.

## Scope boundaries — hard floors

1. **Plain HTML/CSS/JS.** No framework adoption without explicit
   Ray approval. Astro / Next / etc. add complexity this site
   doesn't need.
2. **No analytics by default.** If/when added, must be opt-in
   and privacy-respecting (Plausible-class, not GA/FB).
3. **No CMS.** The site is small enough to edit by hand. Adding
   a CMS adds infra surface for marginal velocity.
4. **Two-surface limit.** `index.html` + `itch.html` are the
   public surfaces. Resist adding /blog, /docs, /pricing as
   separate pages — keep what fits in two pages.

## What devforge-website is NOT

- **Not the docs site.** Devforge's MANUAL + QUICKSTART live in
  the main devforge repo (`docs/`), shipped as PDFs in each
  release zip. The website links to itch but does not host docs.
- **Not the changelog source.** Changelog lives in
  `devforge/CHANGELOG.md`. The website surfaces the *current*
  state, not the archive.

## Public-state rationale

The website is genuinely public — same content as the live site.
No IP, no personal data, no commercial-secret concerns. Tasks and
MISSION sit in the public GS repo at `state/devforge-website/`,
no private-state junction needed.

## Integration posture

- **devforge** (main app repo) — release-cadence dependency.
  When a new app version ships, this site needs an update brief.
- **No other integrations.** Static site, no APIs, no auth.
