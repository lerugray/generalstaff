# SKILL: GeneralStaff README visuals

Reusable skill for making on-brand diagrams for the GeneralStaff
README (and stylistic peers: future `docs/images/*` additions).

## When to use this skill

Reach for it whenever a README or `docs/` asset needs a diagram
that sits alongside `docs/images/banner.png` and
`docs/images/dashboard-hero.png`. Not for generic marketing
visuals, product shots, or dark-mode-first chrome.

## Aesthetic — printed paper, reference-book register

Non-negotiable.

- **Background:** warm cream `#fdfbf7`. Never white, never dark.
- **Ink:** `#2a2520` for body, `#6b5d4f` for muted / meta.
- **Rust accent:** `#7a3b1e`. ONE use per figure, on the single
  load-bearing element. Tint variant `#f3e7db` / `#efe3d5` for
  subtle fills.
- **No SaaS tropes.** No gradients, no neural-net / brain / robot
  icons, no sparkles, no "AI swoosh" shapes, no neon. If it would
  fit in a 20th-century military-history book figure, keep going.
  If it wouldn't, stop.

## Type — two families, small-caps for labels

- **Display serif:** `'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif`
- **Monospace data:** `'IBM Plex Mono','JetBrains Mono','Fira Code',Menlo,Consolas,monospace`
- **Labels:** SMALL-CAPS via literal uppercase + `letter-spacing`
  between 2 and 3 (units: SVG user-space). Don't rely on
  `font-variant: small-caps` — see "rasterization" below.
- **Body / sub-labels:** serif italic, lowercase, sentence case.
- **Figure captions:** monospace, uppercase, muted, with a short
  hairline rule underneath: `FIGURE N · TITLE`.

## Output

- **Format:** SVG preferred; PNG@2x fallback in the same folder.
  Filenames: `{asset}.svg` and `{asset}-2x.png` (do NOT use `@`
  in filenames — some filesystem writers reject it).
- **Location:** `docs/images/`.
- **Dimensions:** author at display size, rasterize at 2× for the
  PNG fallback.
- **Fonts in SVG:** reference the family stack above with
  `font-family="..."`; GitHub-embedded SVGs can't load webfonts,
  so fall back gracefully to the platform serif / mono.

## Rasterization gotchas (learned the hard way)

1. **Don't use `<style>` blocks with CSS classes.** Some
   rasterizers and sanitizers strip `<style>` and leave your
   elements with default `fill:black`. Use direct presentation
   attributes (`fill="..."` / `stroke="..."` / `font-family="..."`)
   on every element.
2. **Avoid `font-variant: small-caps`.** Same reason. Write the
   text in literal uppercase and lean on `letter-spacing` for the
   small-caps feel.
3. **Filename `@2x` is unsafe.** Use `-2x.png` instead.
4. **Rasterizer pipeline:** load the SVG as a `Blob`, create an
   `Image()`, draw to a `createCanvas(w*2, h*2)` with a cream
   `fillRect` first, then `drawImage(img, 0, 0, w*2, h*2)`.

## Composition principles

- **One figure caption per diagram,** top-left, monospace uppercase,
  with a thin horizontal rule underneath. This is what signals
  "this is a reference-book figure, not a SaaS hero."
- **One accent per figure.** Rust goes on the single thing you
  want the reader's eye to land on. If you can't name that thing
  in one phrase, the diagram doesn't have a thesis yet.
- **Subtle tint** (`#efe3d5`-ish) is permissible on a quadrant or
  panel you want to call out positively; reserve rust for the
  load-bearing or warning element.
- **Arrows** use stroke `#2a2520` for primary flow, `#6b5d4f`
  dashed for secondary / return paths. Supply an arrowhead
  `<marker>` per stroke colour.
- **No invented numbers.** If a stat appears, pull it from the
  repo. As of this writing, the verification gate's real rejection
  rate is "211 verified · 20 rejected."

## The three existing figures

### `cycle-flow.svg` — 1200 × 300

Horizontal chain of five rect nodes:
`DISPATCHER → ENGINEER → VERIFICATION GATE → REVIEWER → AUDIT LOG`.
Four forward arrows, plus a dashed, muted return arrow curving
below labelled `next cycle` (closes the loop — the tool IS called
"the cycle"). Rust on the Verification Gate rectangle + its
monospace sub-stat `211 verified · 20 rejected`. All other nodes
in ink.

### `hammerstein-quadrant.svg` — 800 × 800

2×2 grid. X-axis `INDUSTRIOUS ← → LAZY`, Y-axis `CLEVER ↑↓ STUPID`.
Quadrant labels in serif uppercase, body in serif italic.
- Top-left (Clever + Industrious): subtle cream-rust tint;
  rust sub-line `→ THIS TOOL LIVES HERE`.
- Top-right (Clever + Lazy): plain — "You live here."
- Bottom-left (Stupid + Industrious): rust corner-rule (two thick
  strokes along its outer edges) and rust label;
  rust sub-line `→ STRUCTURALLY PREVENTED`.
- Bottom-right (Stupid + Lazy): plain — "Harmless."
- Footer attribution: serif italic muted,
  "after Kurt von Hammerstein-Equord, c. 1933."

### `hard-rules-grid.svg` — 1200 × 500

2 rows × 5 columns of index cards. Each card: `HARD RULE` in
monospace small-caps left, `№ NN` in rust monospace right, hairline
rule, then a 3–5-line gist in serif ink. Footer line below the
grid in serif italic muted.

## README markdown snippets

Centered, so they don't fight the text column:

```markdown
<p align="center">
  <img src="docs/images/cycle-flow.svg"
       alt="The cycle: dispatcher → engineer → verification gate → reviewer → audit log, looped"
       width="900">
</p>

<p align="center">
  <img src="docs/images/hammerstein-quadrant.svg"
       alt="The Hammerstein typology: Clever/Stupid × Industrious/Lazy"
       width="560">
</p>

<p align="center">
  <img src="docs/images/hard-rules-grid.svg"
       alt="The ten hard rules of GeneralStaff"
       width="960">
</p>
```

If GitHub's SVG rendering ever drops fields, swap the `.svg` for
`-2x.png` at the same path.

## Adding a new figure

1. Author the SVG at display size with inline presentation
   attributes (no `<style>`).
2. Cream background rect as the first child.
3. Figure caption top-left: `FIGURE N · TITLE` in mono muted.
4. One rust element, picked deliberately.
5. Save to `docs/images/{name}.svg`.
6. Rasterize to `docs/images/{name}-2x.png` at 2× (cream canvas
   fill first, then `drawImage`).
7. Drop a preview row into `docs/images/preview.html` so you can
   eyeball light + dark surrounds.
