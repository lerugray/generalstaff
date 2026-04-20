# personal-site — Mission (Mode B)

Ray's personal website: a curated public face for four active
businesses (Devforge, CatalogDNA, Retrogaze, Conflict Simulations
LLC), a selection of creative/game/framework projects, and the
flagship Hammerstein essays. Built on Astro, deployed to GitHub
Pages. Taste-heavy — every change is public-facing and shapes how
Ray is perceived across multiple communities.

Registered in GeneralStaff as **Mode B** (interactive-primary + GS
as discipline layer) per `docs/internal/USE-MODES-2026-04-20.md`.
The dispatcher rarely runs bot cycles here; what GS provides is:

- `tasks.json` — canonical "what's queued for the site"
- `MISSION.md` — this file, scope boundary
- `projects.yaml` hands_off — enforced no-touch list
- `PROGRESS.jsonl` — audit trail for any bot work that does run

Creative-work-enabled — bot-drafted blog posts are opt-in, with
voice references and human-in-the-loop review before publication.

## In scope (bot-pickable)

A personal content site has a narrow correctness surface. The bot
can usefully pick up:

- **Build hygiene**: `npm run check && npm run lint` regressions —
  surface + fix Astro type errors, ESLint violations. Verification
  command for every cycle.
- **Dependency updates** — security patches only; major version
  bumps are interactive-only per CLAUDE.md's dependency-pinning
  discipline.
- **Accessibility fixes** — alt text on missing images, heading
  hierarchy fixes, aria-labels where missing. Opt in per-task.
- **Link rot checks** — scripted periodic check for 404s in the
  writing + project pages. Fixes are interactive (the link may
  have moved vs. been removed).
- **Internal script / config maintenance** — `scripts/`,
  `astro.config.mjs` adjustments with clear specs. Opt in
  per-task.

## In scope (creative-tagged, human-reviewed drafts)

All drafts land in `drafts/` at the project root (or wherever
`creative_work_drafts_dir` points). Ray reviews, edits, publishes.
Never directly into `src/content/writing/` or `src/pages/`.

- **Writing drafts** for `src/content/writing/` — new essays or
  blog posts. Must be voice-calibrated against existing
  `hammerstein.md` + `boolean-gates.md`.
- **Page copy updates** for business pages (devforge.astro,
  catalogdna.astro, generalstaff.astro, etc.) — drafts only,
  never in-place.
- **README / about section revisions** — drafts only.

## Out of scope (Ray only — never bot, never creative draft)

Per CLAUDE.md's Advisor Role section, creative + strategic
decisions always get Ray's judgment first:

- **Site architecture** — which pages exist, IA, navigation.
- **Visual design** — layouts, color, typography. Those choices
  define the site's identity.
- **The Hammerstein essay canon** (`src/content/writing/hammerstein.md`,
  plus any future definitive essay) — Ray's voice, not bot
  territory even for "minor" edits.
- **Direct publication** — every creative draft is reviewed
  before it reaches `src/`.
- **Deployment / release** — `git push`, GitHub Pages config,
  domain setup. Ray's call.
- **Public-facing positioning** — taglines, meta descriptions,
  SEO copy. Taste work.

## Creative-work voice calibration

Voice references for bot-drafted creative cycles (configured in
`projects.yaml` §personal-site `voice_reference_paths`):

1. `src/content/writing/hammerstein.md` — the Hammerstein
   operating-principle essay. Primary voice reference.
2. `src/content/writing/boolean-gates.md` — companion essay.

Both are Ray's own prose, dense and structural. Bot drafts should
match register, sentence-length variance, and idiom. No LLM-default
voice (no "unleash", no "revolutionize", no em-dash throat-clearing,
no engagement-bait verbs).

## Success signals

- Ray uses `generalstaff task list --project=personal-site` as his
  canonical "what's next for the site" reference.
- `generalstaff task done --project=personal-site --task=<id>`
  records interactive edits in PROGRESS.jsonl.
- Creative drafts Ray can usably edit (≤ 2x rewrite effort vs.
  writing from scratch).
- `hands_off` never trips (bot never edits a `src/content/writing/`
  file directly, never publishes a creative draft, never touches
  the Hammerstein essay).
- `npm run check && npm run lint` stays green cycle over cycle
  when the bot does run.
