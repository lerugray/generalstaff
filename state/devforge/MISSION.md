# Devforge — mission

## In scope (bot-pickable)

Devforge's bot-pickable surface is narrow by design. The frontend
lives as ~14K lines of inlined JS inside `src/index.html` and is
constrained to ES5-only syntax plus taste-sensitive mode prompts —
not bot territory. What the bot *can* usefully pick up:

- **Rust backend (`src-tauri/src/`)**: add new Tauri commands with
  tests, improve error handling in existing commands, add rustdoc
  comments. `cargo test` is the gate.
- **Smoke tests (`tests/smoke-test.js`)**: expand coverage of the
  node-side validation harness — new test cases for existing
  functions, edge-case assertions, fixture-based tests that don't
  require launching the actual Tauri window.
- **Documentation comments**: rustdoc on `src-tauri/src/lib.rs`
  public functions, JSDoc on any non-hands-off `.js` files if
  they get introduced.
- **Minor build / config improvements**: tauri.conf.json tweaks
  that don't touch the CSP or capability surface (those are
  hands_off), package.json script additions, Cargo.toml lints.

## Out of scope (Ray only — creative / taste work)

- **Mode prompts** — each of Devforge's 16 modes has a
  taste-calibrated system prompt. Not bot territory.
- **`src/index.html`** — the 14K inlined JS/HTML. Changes here
  need to respect the ES5-only rule, the "JS must be inlined"
  Tauri WebView2 constraint, and the grid-layout design intent.
  All of those are taste calls.
- **CSS themes** — `theme-crt.css`, `theme-snes.css`, `layout.css`
  are visual-design surfaces.
- **CLAUDE.md rules files** in `.claude/rules/` — project
  conventions, model routing, decisions. Taste work.
- **ROADMAP.md, IMPROVEMENTS.md, ARCHITECTURE.md** — product
  direction.
- **README.md, CHANGELOG.md** — user-facing copy.
- **Shipped releases in `releases/`** — frozen artifacts.
- **Security-sensitive surfaces**: Tauri capabilities
  (`src-tauri/capabilities/`), CSP in `tauri.conf.json`, shell
  allowlist. Those need Ray's explicit sign-off.

## Creative work

Disabled for Devforge (`creative_work_allowed: false` in
`projects.yaml`). Devforge's copy, mode prompts, and documentation
all need Ray's voice — not a bot draft. If that changes later, it'll
be a deliberate policy change, not a default.

## Success signals

- Test suite grows cycle over cycle on both Rust + smoke-test sides.
- Rustdoc coverage on `src-tauri/src/` rises without touching
  public signatures.
- No cycle rollbacks from touching inlined `src/index.html` or
  mode prompts — hands_off is doing its job.
- Bot never opines on mode design, ES5-vs-modern-JS, or Tauri
  architecture — those are Ray's calls.
