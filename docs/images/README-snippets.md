# README inline-image snippets

Paste these at the appropriate anchors in `README.md`. Centered
`<p align="center">` wrappers so the images don't fight the body
text column on GitHub.

## At `## The approach` — replaces the ASCII flow diagram

```markdown
<p align="center">
  <img src="docs/images/cycle-flow.svg"
       alt="The cycle: dispatcher → engineer → verification gate → reviewer → audit log, looped back to dispatcher"
       width="900">
</p>
```

## At `## The Hammerstein framing` — ships with the framing

```markdown
<p align="center">
  <img src="docs/images/hammerstein-quadrant.svg"
       alt="The Hammerstein typology: Clever/Stupid × Industrious/Lazy. General Staff operates in the Clever+Industrious quadrant; Stupid+Industrious is structurally prevented."
       width="560">
</p>
```

## At the top of `## Hard rules` — above the numbered list

```markdown
<p align="center">
  <img src="docs/images/hard-rules-grid.svg"
       alt="The ten hard rules of GeneralStaff, as a card grid. Full text in the numbered list below."
       width="960">
</p>
```

## PNG fallback

If GitHub ever drops SVG rendering (they haven't, but), swap each
`.svg` for `-2x.png` at the same path; `width` stays the same.
