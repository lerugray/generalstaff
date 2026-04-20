# catalogdna — Mission (GeneralStaff context, Mode B)

catalogdna is registered in **Mode B** — interactive-primary with
GeneralStaff as a discipline layer. Per
`docs/internal/RULE-RELAXATION-2026-04-20-catalogdna.md` and
`docs/internal/USE-MODES-2026-04-20.md`. The dispatcher may rarely
run bot cycles; what GS provides instead is structure around the
interactive work Ray already does on catalogdna:

- `state/catalogdna/tasks.json` — canonical to-do list
- `state/catalogdna/MISSION.md` — this file, scope boundary
- `projects.yaml` §catalogdna `hands_off` — enforced no-touch list
- `state/catalogdna/PROGRESS.jsonl` — audit trail for interactive
  edits (via `generalstaff task done`) and any opt-in bot cycles

catalogdna has its own mature autonomous bot infrastructure
(`run_bot.sh`, `CLAUDE-AUTONOMOUS.md`, `bot_tasks.md`, git worktree
isolation, heartbeat loops). GS's role here is **not** to replace
that bot. GS wraps it only when Ray explicitly opts a task to
`interactive_only: false`; otherwise GS is a tracker.

## In scope (where GS's discipline layer helps)

- **Strategic / product tasks** that need Ray's interactive eye
  but benefit from explicit task tracking: positioning
  experiments, pricing research, early-adopter outreach drafts,
  content-marketing pieces, competitive analysis. All flagged
  `interactive_only: true`.
- **Engineering tasks Ray wants to chunk and track**: vault
  regenerations after template changes, reference-DB population
  of new artists, systematic audits, new-module scaffolding. All
  flagged `interactive_only: true` unless explicitly opted in.
- **Mode-transition candidates** — mechanical tasks that benefit
  from bot automation when Ray's queue drains. The canonical
  example as of registration (2026-04-20):
  - **Reference-DB populate cycles**: `scripts/find_album_urls.py`
    + `populate_reference_db.py` together produce a fully
    mechanical download+convert+analyze+fingerprint pipeline per
    album. No Claude-language decisions inside the scripts. The
    bot picks one unpopulated entry from `wanted_artists.json`,
    runs the two scripts, verifies the reference-db JSON, commits.
    5-15 min per album. See `cdna-004` in tasks.json for the
    concrete task shape.
  - **Playlist-URL retrieval is bot-safe via YouTube Data API**;
    the "song-by-song fallback when playlist_url is flaky" is
    NOT bot-safe (needs interactive judgment about which track
    videos are legitimate). Ray handles the fallback; the bot
    handles the common case.
  - Other mechanical opt-ins (type hints on non-load-bearing
    modules, ruff cleanups on bot-safe areas) can follow the
    same pattern: audit surfaces the task, flip
    `interactive_only` to false, let GS cycle it.

## Out of scope (Ray only, never bot)

Per `RULE-RELAXATION-2026-04-20-catalogdna.md` §"What's explicitly
unchanged":

- **Vault finalization** — `vault-ray/`, `vault-john/`,
  `vault-ray-for-john/` finishing work. Ray's editorial eye is
  the gate.
- **User-facing copy** — landing pages, onboarding text,
  marketing material, anything that represents the product to
  a real user.
- **Analysis pipeline algorithms** — chord detection, scale
  analysis, motif extraction, etc. Already validated on 400+
  tracks; changes compound quickly.
- **`src/catalogdna/interpret/`** — proprietary IP boundary per
  catalogdna's own CLAUDE-AUTONOMOUS.md.
- **Product direction** — roadmap, pricing, positioning, which
  artists to prioritize. Taste work.
- **catalogdna's own bot scaffolding** — `run_bot.sh`,
  `CLAUDE-AUTONOMOUS.md`, `bot_tasks.md`, heartbeat scripts.
  That bot is a separate artifact; GS wraps it but does not
  edit it.

## Creative work

Disabled (`creative_work_allowed: false` in `projects.yaml`).
Creative tasks (blog drafts, outreach emails, content marketing)
are all tracked as `interactive_only: true`, not bot-drafted.
Voice-ref paths aren't meaningful here because the bot never
executes creative cycles on catalogdna.

## Success signals

- Ray uses `generalstaff task list --project=catalogdna` as the
  authoritative "what next" reference during interactive sessions.
- `generalstaff task done --project=catalogdna --task=<id>`
  records completion provenance in PROGRESS.jsonl — audit trail
  captures even interactive work.
- `hands_off` never trips (no bot cycle touches a protected
  surface) because no bot cycle runs on interactive_only tasks.
- If a specific mechanical task gets flipped to bot-pickable and
  runs cleanly, that's a sign the mode boundary is usefully
  permeable. If it trips hands_off, roll back per
  `RULE-RELAXATION-2026-04-20-catalogdna.md` §"Exit criteria".

## Mode boundary

GeneralStaff's `state/catalogdna/` directory and
`projects.yaml` §catalogdna entry do NOT interfere with
catalogdna's own bot cycle. The two systems coexist:
- catalogdna's `run_bot.sh` keeps reading `bot_tasks.md` and
  producing its Phase A/B work.
- GeneralStaff's dispatcher reads `state/catalogdna/tasks.json`,
  sees most tasks are `interactive_only`, skips them, session
  ends cleanly.

Interactive Claude sessions at catalogdna are fair game to
update both systems' state (mark tasks done via `generalstaff
task done`, check off items in `bot_tasks.md`). Bot cycles only
touch their own system.
