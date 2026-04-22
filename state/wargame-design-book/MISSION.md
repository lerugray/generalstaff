# wargame-design-book — Mission (Mode B)

*A Contemporary Guide to Wargame Design* by Ray Weiss — a
practical, opinionated reference on historical board wargame
design. 23 chapters + 6 appendices + acknowledgements, all
content-complete. Free Jekyll web version is live at
`lerugray.github.io/wargame-design-book/`. The remaining work is
commercial: convert the manuscript into a KDP paperback, listed on
Amazon at a target retail of $20, as part of Ray's passive-income
portfolio.

The free web version drives discovery; the paperback is the
monetization artifact. That funnel shapes the project — don't
paywall the content, make the physical book the thing worth
buying, and make the "Buy on Amazon" aux link on the web version
earn its keep.

Registered in GeneralStaff as **Mode B** (interactive-primary + GS
as discipline layer) per `docs/internal/USE-MODES-2026-04-20.md`.
Bot cycles aren't scaffolded yet — `engineer_command` is
fail-closed. What GS currently provides is:

- `tasks.json` — canonical "what's left before hitting publish"
- `MISSION.md` — this file, scope boundary
- `projects.yaml` hands_off — enforced no-touch list (manuscript)
- `PROGRESS.jsonl` — audit trail once bot cycles are enabled

The manuscript source lives in a separate private repo
(`passive-income-hub`). This public repo holds the Jekyll site
plus — once this project lands its scaffolding — the KDP build
pipeline and associated workflow docs.

## In scope (bot-pickable once cycles are enabled)

- **Print PDF pipeline** — Pandoc-based conversion of
  `docs/_chapters/` markdown into KDP-ready paperback PDF with
  correct 6x9 trim, bleed, inside-margin (gutter), outside/top/
  bottom margins, running heads, page numbers, and clean chapter
  breaks. Typography tuned to match the web aesthetic (Lora body,
  Playfair Display chapter headings) sized appropriately for print.

- **Cover template** — front + spine + back as SVG (or
  Pandoc-driven), with spine-width calculator as a function of
  interior page count using KDP's paper-factor formula. Reusable
  for future Ray KDP books.

- **Front / back matter scaffolding** — title page, copyright
  page with ISBN placeholder, auto-generated table of contents
  (derived from chapter front matter), about-the-author stub,
  also-by list, acknowledgements linking.

- **KDP proof-copy workflow doc** — how to order a paperback
  proof, what to check (trim, bleed, gutter, legibility, image
  clarity), iteration loop. Reusable across future Ray KDP projects.

- **KDP launch checklist** — listing fields, category selection
  template, keyword-research worksheet, review-request email
  templates, D-day sequence.

- **KDP royalty analysis** — at $20 retail, KDP's 60% paperback
  royalty minus printing cost, break-even per copy, comparison
  table across alternate price points. Output drives the
  interactive final-price decision.

## In scope (interactive-only — Ray's voice)

- **Amazon listing description** — short (200-char hook) and long
  (4000-char body) copy. Stop-slop pass mandatory before landing;
  public-facing copy where AI-tells get read as AI-tells.

- **Author bio + back-cover hook copy** — jacket voice, the
  Barnes-&-Noble-aisle pitch. Taste work.

- **Keyword + BISAC category selection** — 7 keywords + 2 BISAC
  categories. Positioning strategy; judgment about hobby-games
  taxonomy vs. military-history taxonomy vs. cross-listing.

- **Final retail-price decision** — $20 is the target; actual list
  price is downstream of the royalty analysis.

## Out of scope (Ray only — never bot)

- **Manuscript content** — `docs/_chapters/` is hands-off. Content
  edits happen in the source repo (`passive-income-hub`), never
  here. The project's own `CLAUDE.md` already encodes this rule;
  GS's `hands_off` mirrors it as defense-in-depth.

- **Visual cover art direction** — bot provides the cover
  template (trim, bleed, spine math, text positioning layers).
  The actual cover artwork and typography-as-design is Ray's taste
  call (or a designer Ray hires).

- **Existing Jekyll web site layout / CSS / JS** — the
  2026-03-31 audit fixes have already shipped. Web aesthetic is
  frozen for now; KDP work doesn't touch the web build.

- **KDP account interactions** — uploading, pricing submission,
  publishing live. Ray's fingers on the keyboard.

- **ISBN strategy** — KDP-assigned vs. Ray's own Bowker ISBN vs.
  imprint decisions. Business call.

- **Marketing / launch promotion** — who to email for reviews,
  which communities to notify, social-media rollout, newsletter
  coordination. Ray's call with voice + relationship context the
  bot doesn't have.

## Success signals

- `generalstaff task list --project=wargame-design-book` is Ray's
  canonical "what's left before publish" list.
- The paperback ships on Amazon at Ray's chosen retail price.
- The free web version measurably clicks through to the Amazon
  listing (funnel works).
- Ray sees recurring passive-income royalties — first real revenue
  from the wargame-design portfolio.
- The print-PDF + cover-template + workflow docs are reusable for
  future CSL / reference-book / design-book KDP projects.
- `hands_off` never trips — bot never edits `docs/_chapters/`,
  never uploads to KDP, never publishes public-facing copy that
  hasn't been through Ray + `/stop-slop`.
