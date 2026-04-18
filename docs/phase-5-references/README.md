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

## Conventions for this directory

- One subdirectory or zipped artifact per design artifact.
- Date-stamp the folder or zip name when adding new references.
- Don't unzip artifacts in-tree — keep the zip as the canonical form so
  iterations stay distinct.
- This directory is NOT hands-off; both bot cycles and interactive
  sessions can reference or add artifacts here. Adding doesn't require
  a task in `tasks.json` — it's a research surface.
