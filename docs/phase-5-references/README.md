# Phase 5 UI references

Design artifacts pointing at the UI work that begins in Phase 5 per
`PIVOT-2026-04-15.md` / `UI-VISION-2026-04-15.md`. These are reference
inputs, not production code — they inform the taste the UI should land
on, not the specific implementation.

## 2026-04-18 — gamr profile-card (Claude Design output)

`gamr-prototype.zip` contains Claude Design's output from the brief in
`FUTURE-DIRECTIONS-2026-04-15.md` §7 addendum-2. Ray relayed a brief for
the gamr profile-card view (strictly platonic gamer matching) and got
back a complete React + Tailwind component + HTML render + 4
progression screenshots.

**Why it's kept here:** the aesthetic the prototype lands on — analog
index-card metaphor, warm cream palette, keyboard-first interaction,
typographic hierarchy — is directly adjacent to the kriegspiel /
command-room direction in `UI-VISION-2026-04-15.md`. Both reject the
Discord-dark-purple and SaaS-gradient defaults in favor of considered,
legible, taste-heavy design. When Phase 5 starts, this is the first
design-language reference to review.

**Contents (after unzip):**
- `app.jsx`, `card.jsx`, `components.jsx` — React components
- `data.js` — sample data for the card view
- `gamr profile card.html` — standalone rendered page
- `styles.css` — the type+palette system
- `screenshots/current.png`, `v2.png`, `probe.png`, `final.png` —
  progression through Claude Design's own iteration loop

**Known issues in the output** (noted by Ray 2026-04-18):
- Some text overlap on the left column (Theo G. name bleeds through)
- Games cards column overlaps platforms/contexts column

These are cleanup-level; the underlying design language is the load-
bearing artifact. Another human or a UI-specific bot cycle can iterate
the layout without re-running Claude Design.

## 2026-04-18 — fleet overview (Claude Design output, Phase 5 anchor)

`fleet-overview-2026-04-18.zip` contains the first Phase 5 UI artifact:
the fleet-overview landing page, rendered as a single self-contained
HTML file. This is the **anchor brief** for the Phase 5 UI — the view
whose vocabulary (palette, typography, components) the rest of Phase 5
is meant to reuse by hand without burning further Claude Design budget.

**Contents (after unzip):**
- `Fleet Overview.html` — the standalone view, real fleet data in cells
- `uploads/final.png` — the gamr reference image that was attached to
  the brief (redundant with `gamr-prototype.zip` but kept by CD)

**What it establishes (reusable across future Phase 5 views):**
- 10-variable palette (paper / ink / rule / rust with soft/faint/ghost
  tiers) anchored at `#f1e7d3` warm cream
- 3-family type stack: Spectral (display serif) + JetBrains Mono
  (tabular nums) + Archivo Narrow (small-caps labels)
- Layout vocabulary: masthead + docline + sheet container + sec-head +
  summary band + afterword + colophon — five distinct patterns
- Signal conventions: `●`/`○` typographic on-off, single rust accent
  for "this needs your eyes," `→` marker for most-recent activity,
  em-dash for N/A cells

**What's invented (not wired to real data):**
- `localhost:7823` port is a placeholder — the dashboard's real port
  hasn't been picked yet
- `sheet 01 / fleet`, `Rev. 0.4 · April 2026`, `rendered 14:02`,
  `pid 48213`, `page 1 of 1` — decorative "printed dispatch sheet"
  chrome; kept as placeholders that'll be wired to real values when
  the view gets a real implementation
- `"A quiet desk for loud machines."` — tagline CD invented; not
  officially claimed as the project's voice
- The `.hot` rust styling on raybrain's 87 failures uses an
  unthresholded judgment call (CD chose it by eye); a real rule like
  "hot = >50% of this project's cycles failed" should replace it when
  the view is implemented

**What's real:** every row value, every derived number in the summary
band (57% pass rate = 156/273 ✓), every attribution claim in the
afterword prose. Data accuracy checked at commit time.

**Budget discipline observed (2026-04-18):** CD offered three follow-up
options after the first pass (accent dialed up/down, alternate type
pairing, second variation). All three declined per the anchor strategy
— first pass was strong enough to serve as vocabulary reference, and
any of the offered iterations would have burned 5-10% more weekly
budget for marginal polish. Subsequent Phase 5 views (session tail,
task queue, dispatch detail, inbox) are meant to be hand-built reusing
this CSS, not re-briefed.

## 2026-04-18 — task queue (hand-built, zero Design spend)

`task-queue-v1.html` is the second Phase 5 view, built by extending
the fleet-overview anchor's CSS vocabulary without touching Claude
Design. It's per-project (as opposed to fleet-overview's
cross-project view) and renders the queue for `generalstaff` with
four sections: in-flight, ready-for-pickup, blocked-on-taste, and a
compact recently-shipped rail.

**What carries over verbatim from the anchor:**
- Full 10-variable palette
- Type stack (Spectral / JetBrains Mono / Archivo Narrow)
- Masthead + docline + sheet + section-head + summary-band +
  afterword + colophon — every structural pattern
- `.attn` highlight, `.note .em` inline tags, hairline rules, dash
  conventions, ON/OFF typographic indicators

**New vocabulary this view adds (extension of the anchor):**
- `.task` — 3-column grid (priority / body / right-aside) for
  structured records that don't fit a flat table
- `.pri.p1/.p2/.p3` — priority small-caps with tiered colors (rust
  for P1, ink-soft for P2, ink-ghost for P3)
- `.flag.interactive` and `.flag.in-flight` — rust-toned status
  flags for non-pickable reasons and active runs
- `.summary-line` — Spectral italic treatment for task titles (one
  visual step down from the masthead headline)
- `.meta` with `.touch` chips — monospaced path lists with `.hot`
  variant for hands-off intersections
- `.aside` — right-aligned temporal metadata (age label + value)
- `.shipped .task` override — compact row variant for high-density
  ambient-context rails

**What's synthesized (real queue was empty at build time):**
- `gs-221..226` don't exist. All `expected_touches` reference real
  files in the repo so paths read honestly, but descriptions are
  fabricated. Same placeholder pattern as the fleet-overview
  invented chrome — will be replaced with live data when the view
  is wired up.

**One deliberate violation of the anchor's "no animation" rule:**
- `.flag.in-flight` pulses at 1.8s on its rust dot. This isn't a
  loading state — it signals a cycle that's actively running right
  now. Ambient status, not decoration. If it reads as fidgety when
  implemented live, delete the `@keyframes pulse` rule and the
  `animation:` declaration — the static dot still reads correctly.

**What this validates for Phase 5:** the anchor CSS generalizes to a
non-tabular data shape (structured records with per-item metadata,
status flags, and nested lists) without new Design spend. Budget
discipline ratio observed: 1 anchor brief (~5-10% weekly budget)
produced reusable vocabulary for 2 distinct views and counting.
Remaining Phase 5 views (session tail, dispatch detail, inbox) are
expected to follow the same extension pattern.

## 2026-04-18 — session tail (hand-built, zero Design spend)

`session-tail-v1.html` is the third Phase 5 view. Temporal/streaming
data shape — a dispatch log of recent bot sessions, newest first,
each cycle rendered as a "dispatch from the field" block. Built by
extending the anchor + task-queue vocabularies; no Claude Design
spend.

**What carries over from prior views:**
- Full palette, type stack, masthead, docline, summary band,
  section head, afterword, colophon — structural skeleton
  identical to fleet-overview + task-queue
- The 3-column grid pattern (left-narrow / body / right-narrow)
  established in task-queue's `.task` reused here as `.dispatch`
- `.attn` highlight, `.note .em` inline tags, dash conventions,
  tabular-num numerals, Archivo Narrow small-caps labels

**New vocabulary this view adds:**
- `.session-head` — session-level banner (session id + open time +
  budget + reviewer + slot config + stop reason)
- `.dispatch` — per-cycle block, grid is timerail / body / aside
  (mirrors `.task` pattern but swaps pri-column for timerail)
- `.timerail` — stacked start/end timestamps with arrow glyph and
  elapsed-duration edge tag in small caps
- `.cycle-heading` — task id in Spectral + verdict chip with square
  dot (verified=ink / failed=rust) + cycle_id drifted right in faded
  mono
- `.phases` — engineer → verify → review strip with per-phase
  durations, arrow separators styled in Archivo Narrow
- `.verdict-prose` — italic Spectral pull-quote treatment with
  curly-quote glyphs and hairline left-border, carries the
  reviewer's actual prose reason
- `.files-row` — mono path list with inline `+126` / `−23` diff
  indicators
- `.session-end` — closing ribbon matching the session_end event
  (rule above, mono timestamp, outcome summary)
- `.earlier-row` — compact one-line rail for older sessions,
  cross-project (mixed-outcome sessions styled in rust)

**Real data shipped in the view:**
- Sessions `bc4nbrro5` (gs-220, gs-216) and `b05evw3nt` (gs-217,
  gs-218, gs-219) — actual SHAs, actual verdict prose, actual file
  touches pulled from `state/generalstaff/PROGRESS.jsonl`

**What's fabricated:**
- Per-phase durations inside each cycle (engineer + verify + review
  splits). The PROGRESS.jsonl has real cycle-total durations but
  not per-phase splits of the engineer step itself; the splits are
  plausible and sum to the real total
- The earlier-sessions rail — session IDs look real but timings and
  cycle counts are inferred/invented (b9m3kvq0a's "82 cycles
  retry-spin" is rooted in the real morning incident documented in
  `CLAUDE.md` §"Report fidelity")

**Rust-accent rule consolidating across all three views:**
Rust = "this asks for your eyes, whether attention-good or
attention-bad." Used for P1 priorities, in-flight dots, interactive
flags (queue); failed verdicts, mixed-outcome sessions (tail);
bot-pickable cell, hot failure counts (fleet). Consistent meaning
across views — a reader learns it once.

**Phase 5 remaining:** dispatch detail (per-cycle drill-in with
full REVIEW.md + diff view), inbox (state/_fleet/messages.jsonl
shared channel). Both expected to follow the same hand-extension
pattern.

## Conventions for this directory

- One subdirectory or zipped artifact per design artifact.
- Date-stamp the folder or zip name when adding new references.
- Don't unzip artifacts in-tree — keep the zip as the canonical form so
  iterations stay distinct.
- This directory is NOT hands-off; both bot cycles and interactive
  sessions can reference or add artifacts here. Adding doesn't require
  a task in `tasks.json` — it's a research surface.
