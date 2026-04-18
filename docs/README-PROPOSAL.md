# README Outline Proposal

**Purpose:** Structural proposal for a revised `README.md` following the
[matiassingers/awesome-readme](https://github.com/matiassingers/awesome-readme)
checklist. Retrieval and outlining only — no narrative prose. Voice,
positioning, and final wording to be composed in a later interactive
session (per `FUTURE-DIRECTIONS-2026-04-15.md` §6 README dogfooding
proposal).

**How to read this file:** each section heading is the proposed
section. Bullets describe *what belongs there*. Each bullet cites
the source doc whose existing content should seed that bullet.

> **Staleness note (2026-04-18):** the specific `README.md` line
> numbers cited in bullets below refer to the 2026-04-17 README
> state. That README was rewritten on 2026-04-18 to reflect
> Phases 1-4 shipped (previously "Phase 1 shipped") and the
> re-sequenced roadmap (Phase 4 = parallel worktrees, not Tauri
> UI). The structural proposal itself is still the intended
> shape, but line references will not match the current file.
> When the "later interactive session" mentioned above actually
> runs, regenerate line refs from the current `README.md`.

---

## 1. Title + Tagline

- Project name "GeneralStaff" (source: `README.md` line 1).
- Two-line tagline pair: "Open-source autonomous engineering for solo
  founders." + "Your code. Your keys. Your control." (source:
  `README.md` lines 3–4).
- One-sentence elevator describing the meta-dispatcher + verification
  gate + audit log (source: `README.md` lines 6–9).

_Voice: anti-Polsia positioning spine per VOICE.md §1 — the tagline can be unembarrassed about the labor-economics framing ("your code, your keys, your control" already reads as anti-extraction)._

## 2. Badges

- Placeholder row — none ship yet in the current README. Candidates
  once repo is public: build status, test count, license (MIT per
  `README.md` line 209), phase/status.
- Static status line is already in `README.md` lines 11–15 and could
  collapse into badges + one sentence.

_Voice: neutral technical._

## 3. Status / Maturity callout

- Current "Status (2026-04-16)" blockquote (source: `README.md` lines
  11–15) — phase-1 shipped numbers, zero false positives, private
  repo, cross-platform.
- Roadmap pointer ("you are here") mirrors the Phase 7 line (source:
  `README.md` line 185).

_Voice: add dogfooding credibility line per VOICE.md §Dogfooding README placement — matter-of-fact, not triumphant, per VOICE.md §Voice for this claim._

## 4. Visuals / Demo

- Not in current README. Candidates when available:
  - `generalstaff status` screenshot (CLI surface defined in
    `PHASE-1-SKETCH-2026-04-15.md` §"CLI surface").
  - Sample `digest_*.md` excerpt (schema in `DESIGN.md` §"Open audit
    log entry format").
  - UI preview deferred to Phase 4/5.5 (source:
    `UI-VISION-2026-04-15.md` §"When this happens";
    `README.md` lines 182–184).

_Voice: neutral technical._

## 5. The problem

- Failure mode framing: "industrious without judgment" + Polsia
  Trustpilot signal about false completions (source: `README.md`
  lines 17–25).
- Optional: the same framing in Hammerstein-quadrant terms (source:
  `README.md` §"The Hammerstein framing" lines 125–143; deeper
  grounding in `PIVOT-2026-04-15.md` §"Why pivot").

_Voice: lean into anti-slop + anti-extraction framing from VOICE.md §1; optional Falk & Tsoukalas anchor per VOICE.md §Mainstream-economics anchors ("automation arms race", "demand externalities")._

## 6. The approach / How it works

- ASCII pipeline diagram (source: `README.md` lines 29–32).
- Verification gate bullet (source: `README.md` lines 34–37;
  full spec in `DESIGN.md` §"Verification gate spec").
- Hands-off lists bullet (source: `README.md` lines 38–40).
- Worktree isolation bullet (source: `README.md` lines 41–44).
- BYOK bullet (source: `README.md` lines 45–47;
  `RULE-RELAXATION-2026-04-15.md` §"Hard Rule #8").
- Open audit log bullet (source: `README.md` lines 48–50;
  format in `DESIGN.md` §"Open audit log entry format").

_Voice: reference PROGRESS.jsonl as observable evidence per VOICE.md §Dogfooding README placement — "don't trust the claim, read the log and count rejections yourself."_

## 7. Prerequisites / Installation

- Toolchain list: git, bash, bun 1.2+, claude CLI (source: `README.md`
  lines 54–55).
- `git clone` + `bun install` + `bun link` + `generalstaff doctor`
  block (source: `README.md` lines 57–63).

_Voice: neutral technical._

## 8. Quickstart / Usage

- `generalstaff init` + edit `projects.yaml` + `config` + `cycle
  --dry-run` flow (source: `README.md` lines 65–73).
- Real session: `generalstaff session --budget=90` + `history
  --lines=20` (source: `README.md` lines 75–80).
- Reassurance line: bot only pushes to `bot/work`, export = git clone
  (source: `README.md` lines 82–83; `RULE-RELAXATION-2026-04-15.md`
  §"Hard Rule #7").

_Voice: mostly neutral technical; the reassurance line (bot only pushes to `bot/work`, export = git clone) can echo the anti-extraction framing per VOICE.md §1 — the user owns the code, always._

## 9. Configuration

- Point at `projects.yaml.example` as schema reference (source:
  `README.md` line 195).
- Per-project fields summary: `engineer_command`,
  `verification_command`, `cycle_budget_minutes`, `hands_off` patterns
  (source: `README.md` lines 68–70; schema in `DESIGN.md` §"Project
  registry schema").
- Reviewer provider env vars: `GENERALSTAFF_REVIEWER_PROVIDER`,
  `GENERALSTAFF_REVIEWER_MODEL`,
  `GENERALSTAFF_REVIEWER_FALLBACK_PROVIDER`, `OPENROUTER_API_KEY`,
  `OLLAMA_HOST` (source: `CLAUDE.md` §"Reviewer provider
  configuration").

_Voice: neutral technical._

## 10. Features

- Bulleted feature list, drawn from the 15 CLI commands in
  `src/cli.ts` usage (source: `PHASE-1-SKETCH-2026-04-15.md` §"CLI
  surface"; can be cross-checked against `README.md` line 11–15
  "15 CLI commands" claim).
- Phase 1 "Definition of done" bullets as features list (source:
  `PHASE-1-PLAN-2026-04-15.md` §"Definition of done for Phase 1";
  `PHASE-1-SKETCH-2026-04-15.md` §"Definition of done for Phase 1").

_Voice: neutral technical._

## 11. Why this over the alternatives

- Polsia / Devin / closed SaaS contrast (source: `README.md` lines
  87–91; deeper analysis in `PIVOT-2026-04-15.md` §"Polsia research
  summary" and §"Strategic positioning").
- Naive `claude -p` loops contrast (source: `README.md` lines 92–96).
- Hand-rolled nightly scripts contrast (source: `README.md` lines
  97–99; historical context in `research-notes.md`, per `CLAUDE.md`
  §"Read first" order).

_Voice: direct Polsia comparison allowed per VOICE.md §1; keep pointed not screed per §2; dogfooding contrast is structural not rhetorical per VOICE.md §Dogfooding (Polsia-model tools cannot be dogfooded publicly)._

## 12. Who this is for

- "Bring your own imagination" neutral-on-motivation framing (source:
  `README.md` lines 101–123; full argument in
  `FUTURE-DIRECTIONS-2026-04-15.md` §4 "Bring Your Own Imagination
  Framing").
- Hard Rule #1 still holds — correctness work, not creative work
  (source: `README.md` lines 119–123;
  `RULE-RELAXATION-2026-04-15.md` §"Hard Rule #1").

_Voice: human-livability is the universal per VOICE.md §3 — Hard Rule 1 (taste work stays with user) is the architectural form of the thesis per VOICE.md §Personal context._

## 13. The Hammerstein framing (philosophy)

- Origin of the name + clever-industrious vs stupid-industrious
  (source: `README.md` lines 125–143).
- Forward reference to `docs/internal/` once public (source:
  `README.md` lines 140–143).

_Voice: the Marxist-compatible reading per VOICE.md §Intellectual framing is fair game — inherit the operational philosophy without inheriting the politics._

## 14. Hard rules

- All 10 rules, one line each (source: `README.md` lines 145–169;
  canonical list in `RULE-RELAXATION-2026-04-15.md` §2 + §3).
- Pointer to `RULE-RELAXATION-2026-04-15.md` for rationale (source:
  `README.md` line 171).

_Voice: each rule is a labor choice per VOICE.md §1; Rules 7 (user owns the code), 8 (BYOK), 9 (open audit log), and 10 (local-first) carry the structural anti-extraction stance and can be framed as such._

## 15. Roadmap

- Phase 2 (multi-provider routing) (source: `README.md` lines
  175–179; full plan in `FUTURE-DIRECTIONS-2026-04-15.md` §2 and the
  2026-04-16 tier taxonomy update).
- Phase 3 (second managed project) (source: `README.md` lines
  180–181; candidate discussion in
  `FUTURE-DIRECTIONS-2026-04-15.md` §5 on Retrogaze).
- Phase 4 (Tauri UI) (source: `README.md` line 182;
  `RULE-RELAXATION-2026-04-15.md` §5.1 UI framework resolution).
- Phase 5.5+ (Kriegspiel theme) (source: `README.md` lines 183–184;
  `UI-VISION-2026-04-15.md` in full).
- Phase 7 (public launch) (source: `README.md` line 185).
- Later phases (simulation mode, budget guards, fleet viewer,
  multi-bot) available for a "Long-term ideas" expandable section
  (source: `FUTURE-DIRECTIONS-2026-04-15.md` §1, §3, §7, §8).
- Revised 12-phase plan reference (source: `PIVOT-2026-04-15.md`
  §"Phased build plan (revised)").

_Voice: neutral technical._

## 16. Documentation

- Pointer list already in current `README.md` lines 187–200.
  Confirm/expand with newer docs when ready:
  - `DESIGN.md` (v1 + v2 append-only).
  - `PIVOT-2026-04-15.md`.
  - `PHASE-1-PLAN-2026-04-15.md`.
  - `PHASE-1-RESOLUTIONS-2026-04-15.md` (could be added — currently
    missing from the README list).
  - `PHASE-1-SKETCH-2026-04-15.md` (could be added).
  - `FUTURE-DIRECTIONS-2026-04-15.md` (could be added).
  - `RULE-RELAXATION-2026-04-15.md` (already linked inline at line
    171; consider duplicating here for discoverability).
  - `UI-VISION-2026-04-15.md` (already linked at line 184).
  - `projects.yaml.example`.
  - `CLAUDE.md`.
  - `research-notes.md`.

_Voice: neutral technical._

## 17. Tests

- Not in current README. Candidate one-liner: "bun test" runs the
  suite; coverage numbers cited in the Status block (source:
  `README.md` line 12; structure in
  `PHASE-1-SKETCH-2026-04-15.md` §"Test strategy").

_Voice: neutral technical._

## 18. Contributing

- Current stub about pre-public + PROGRESS.jsonl feedback loop
  (source: `README.md` lines 202–207).
- Expand once public: CONTRIBUTING.md link, code of conduct, issue
  template guidance (no current source — TBD at public launch).

_Voice: neutral technical; the PROGRESS.jsonl feedback loop line ties naturally to the dogfooding claim per VOICE.md §Dogfooding — contributors can inspect the same audit log the tool shows its users._

## 19. License

- MIT (source: `README.md` line 209).

_Voice: neutral technical._

## 20. Acknowledgements / Prior art

- Not in current README. Candidates:
  - Prior-art survey: nightcrawler, parallel-cc, Polsia,
    Continuous-Claude-v3 (source: `research-notes.md` per
    `CLAUDE.md` §"Read first" item 5).
  - Hammerstein framing lineage from catalogdna's "AI Collaboration
    Principles" (source: `CLAUDE.md` §"Hammerstein context";
    external path noted there).

_Voice: mostly neutral technical; the Hammerstein lineage attribution can lean on VOICE.md §Intellectual framing — credit the operational-philosophy reading, not the politics of its origin._

## 21. FAQ (optional)

- Candidate seed questions from existing content:
  - "Will it touch my main branch?" → `README.md` lines 82–83 +
    Hard Rule #7.
  - "What if the bot hallucinates a task is done?" → `README.md`
    §"The approach" + Hard Rule #6.
  - "Do I have to pay for a platform?" → Hard Rule #8 (BYOK).
  - "Can I use it with non-Claude models?" → reviewer provider
    section (`CLAUDE.md` §"Reviewer provider configuration"); full
    roadmap in `FUTURE-DIRECTIONS-2026-04-15.md` §2.
  - "How do I stop the bot from touching file X?" → Hard Rule #5,
    `projects.yaml.example`.

_Voice: neutral technical for the procedural Qs (Q1, Q2, Q5); the "pay for a platform" (Q3) and "non-Claude models" (Q4) answers can surface the BYOK / anti-extraction stance per VOICE.md §1 plainly and without hedging._

---

## Source docs consulted

- `README.md` (current, 209 lines) — primary seed.
- `CLAUDE.md` — reviewer config, session context, Hammerstein pointer.
- `DESIGN.md` — architecture (v1 + v2), verification gate spec,
  audit-log format.
- `PIVOT-2026-04-15.md` — mission change, Polsia research,
  positioning, phased plan.
- `FUTURE-DIRECTIONS-2026-04-15.md` — model plurality, BYOI framing,
  roadmap items beyond Phase 4.
- `RULE-RELAXATION-2026-04-15.md` — canonical Hard Rules list and
  rationale; Phase 1 resolved decisions.
- `UI-VISION-2026-04-15.md` — Kriegspiel theme, UI timing.
- `PHASE-1-PLAN-2026-04-15.md` — shipped Phase 1 workflow and DoD.
- `PHASE-1-RESOLUTIONS-2026-04-15.md` — resolved Phase 1 open
  questions (work detection, reviewer prompt, concurrent-run
  detection, state-dir location).
- `PHASE-1-SKETCH-2026-04-15.md` — CLI surface, file structure, test
  strategy.
- `VOICE.md` — editorial calibration for public writing (added for
  gs-110 voice annotations above).

## Gaps flagged

- No current sources for Tests, Acknowledgements, or FAQ sections —
  those entries above are TBD-at-public-launch placeholders.
- "15 CLI commands" count in the Status block is currently
  README-only; the authoritative source is `src/cli.ts`. A check
  against `src/cli.ts` is recommended before publishing.
- Badges row has no source — needs a separate decision about which
  CI provider to surface, per `RULE-RELAXATION-2026-04-15.md` §5.5
  (distribution channel resolved; CI choice is adjacent but
  distinct).
