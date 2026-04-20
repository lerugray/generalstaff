# Bookfinder General — mission

## In scope (bot-pickable)

- Test coverage: expand the pytest suite that bf-001 seeds.
- Type hints: add full type annotations to modules with none
  currently (config.py, library.py, cli.py).
- Error handling: catch + log edge cases in extractor.py,
  download.py per the "every code path returns JSON, never
  raises" CLAUDE.md rule.
- Docstrings: write PEP 257 docstrings for public functions in
  any module except the four hands_off modules.
- Refactors with clear specs: extract helper functions, dedupe
  similar code paths, rename for clarity.
- Bug fixes with minimal-repro tests.
- Performance: micro-optimizations with before/after benchmarks
  (don't touch the large-PDF skip logic or EPUB exemption
  without a brief from Ray).

## In scope (creative-tagged, human-reviewed drafts)

- README section drafts — bot drafts to drafts/, Ray edits, Ray
  publishes.
- Launch post drafts (HN, r/selfhosted, r/LocalLLaMA variants).
- MCP tool usage examples for README.
- Feature blurbs for new functionality.
- Voice-calibrated to Ray's PIH manuals + any additions he
  supplies via voice_reference_paths.

## Out of scope (Ray only)

- Anything touching a hands_off file (see projects.yaml entry).
- Changing the Playwright threading model or MCP stdout
  discipline — those are CLAUDE.md "CRITICAL RULES" and encoded
  as hands_off.
- Dependency version changes (strict pinning convention).
- Redesigning the MCP tool surface (9 tools currently — adding
  or removing one is a product decision).
- Anything related to Anna's Archive's legal/compliance
  posture. The bot doesn't opine on that; Ray decides.
- User-facing copy that ships directly without Ray's review
  (creative tasks always land in drafts/, never published
  autonomously).
- Product direction, roadmap, pricing (if it ever gets a paid
  tier — currently free).

## Success signals

- Test suite grows cycle over cycle, verified rate stays high.
- No cycle rollbacks due to touching a CLAUDE.md "CRITICAL
  RULE" module — hands_off is doing its job.
- Creative drafts Ray can usably edit (≤ 2x rewrite effort vs.
  writing from scratch).
- Bot never publishes a creative draft directly (guardrail 2
  from RULE-RELAXATION-2026-04-20).
