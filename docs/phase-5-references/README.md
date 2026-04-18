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

## Conventions for this directory

- One subdirectory or zipped artifact per design artifact.
- Date-stamp the folder or zip name when adding new references.
- Don't unzip artifacts in-tree — keep the zip as the canonical form so
  iterations stay distinct.
- This directory is NOT hands-off; both bot cycles and interactive
  sessions can reference or add artifacts here. Adding doesn't require
  a task in `tasks.json` — it's a research surface.
