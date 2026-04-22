# Claude Design brief — GeneralStaff README visuals

## Project context

GeneralStaff is a local-first, open-source autonomous coding-agent
dispatcher with a mandatory verification gate. Positioned as the
open alternative to closed SaaS platforms (Polsia, Devin). BYOK,
hands-off lists per project, full `PROGRESS.jsonl` audit log.

The `README.md` at repo root (also on GitHub at
`github.com/lerugray/generalstaff`) is the primary launch surface.
Two on-brand diagrams (with an optional third) would replace the
current ASCII flow and make two key concepts scan in one look.

## Visual direction

Quoting the README verbatim:

> printed paper. Warm cream background, serif for display,
> monospace for data, small-caps labels, a single rust accent used
> only where something needs your eyes. No SaaS gradients, no
> dark-mode-by-default.

Type pairings (Ray's established set):
- Serif display: **Playfair Display** (headings) or **Lora** (body)
- Monospace data: **IBM Plex Mono** or similar (JetBrains Mono /
  Fira Code also fit the register)

Color anchors (pull exact hex from the Phase 5 references in-repo):
- Warm cream background (`#fdfbf7`-ish — Ray's other projects)
- Rust accent (`#7a3b1e`-ish) — once per diagram, maximum
- Navy or ink-dark text

Source-of-truth visual references already in the repo:
- `docs/phase-5-references/` — five hand-built dashboard reference
  views. Extend this vocabulary; don't contradict it.
- `docs/images/banner.png` and `docs/images/dashboard-hero.png` —
  stylistic peers. New assets should read as part of the same set.

## Output format

- **Preferred:** SVG (scales, tiny, editable)
- **Acceptable fallback:** PNG at 2x pixel density
- Land at `docs/images/` next to `banner.png` and `dashboard-hero.png`
- Must render legibly on both GitHub light AND dark backgrounds
  (PNG bake in the printed-paper palette is fine; the existing
  banner + dashboard hero already accept the dark-mode surround)

## Assets requested

### Asset 1 — The cycle flow

**Purpose.** Replaces the ASCII diagram in `## The approach`:

```
 dispatcher --> engineer --> verification gate --> reviewer --> audit log
    (picks)    (codes)     (tests must pass)    (scope match)   (open)
```

**Layout.** Horizontal, ~1200×300 (2x for PNG), left-to-right,
readable on mobile.

**Content.** Five nodes, four arrows. Each node: small-caps label
(`DISPATCHER`, `ENGINEER`, `VERIFICATION GATE`, `REVIEWER`,
`AUDIT LOG`) with an italic lowercase sub-label (`picks`, `codes`,
`tests must pass`, `scope match`, `open`).

**Accent.** Rust on `VERIFICATION GATE` only — it's the load-bearing
piece the whole README argues for.

**Tone.** Reference-book diagram. NOT a SaaS flowchart with
gradients or neon boxes.

### Asset 2 — The Hammerstein 2×2

**Purpose.** Ships with `## The Hammerstein framing`. Makes the
tool's name click. The framing is the product's intellectual
backbone.

**Layout.** Square, ~800×800 (2x for PNG).

**Content.** 2×2 grid. X-axis: **Industrious ← → Lazy**. Y-axis:
**Clever ↑↓ Stupid**. Four quadrant labels (Hammerstein's actual
typology, faithful to the source):

- **Clever + Industrious** → *"General Staff — execution with
  judgment. This tool lives here."*
- **Clever + Lazy** → *"Strategic command. You live here."*
- **Stupid + Industrious** → *"Unbounded damage. Hammerstein said
  dismiss at once. This tool structurally prevents it."*
- **Stupid + Lazy** → *"Routine duties. Harmless."*

**Accent.** Rust on `Stupid + Industrious` (the warning). Subtle
tint on `Clever + Industrious` to highlight where the tool operates.
Other two quadrants in restrained tone.

**Tone.** Could be a figure from a 20th-century military-history
book. Understated, not neon-infographic. (Hammerstein is the
source; the aesthetic should honor that.)

### Asset 3 (optional stretch) — Hard Rules as card grid

**Purpose.** Turns `## Hard rules` from a 10-item numbered list
into a scannable grid. Keep the existing numbered list (for
accessibility + grep-ability); the card grid is a visual summary
at the top of the section.

**Layout.** 2 rows × 5 columns (or 5×2), ~1200×500 (2x for PNG).

**Content.** 10 cards, one per Hard Rule. Each card:
- `HARD RULE #N` in small-caps
- One-phrase gist (use the bold first sentence of each rule as
  written in the README)

**Accent.** Rust on rule numbering only. Cards otherwise uniform.

**Tone.** Hand-labeled index cards, printed-paper register.

## Constraints

- **No SaaS iconography.** No gradients, no neural-net / brain /
  robot icons, no sparkles, no "AI swoosh" shapes. The project
  positions against that register.
- **No dark-mode-by-default.** Warm cream background is canonical.
- **Rust accent is restrained.** One use per diagram, on the single
  element that's load-bearing.
- **Type discipline.** Serif display + monospace data is the pattern.
  Small-caps for labels. Sentence-case for body.
- **No invented statistics.** If a diagram needs a number, use one
  from the README (e.g. "211 verified / 20 rejected" for the gate's
  real rejection rate).

## Output expectations

A `SKILL.md` emitted by Claude Design that future sessions can
reuse (lives at `.claude/skills/readme-visuals.md` or similar),
plus each asset as a file:

- `docs/images/cycle-flow.svg` (or `.png`)
- `docs/images/hammerstein-quadrant.svg` (or `.png`)
- `docs/images/hard-rules-grid.svg` (or `.png`) — if Asset 3 shipped

Plus the README inline-image markdown for each, ready to paste at
the right section anchors.
