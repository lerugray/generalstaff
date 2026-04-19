# Rule relaxation — 2026-04-19 (gamr creative-work opt-in)

**Status:** Per-project relaxation, scoped to gamr only. Other
managed projects (generalstaff, raybrain) retain the stricter
Hard-Rule-1 default. Other relaxations (architectural, dispatcher-
wide) happen under their own dated RULE-RELAXATION documents per
the repo's relaxation protocol.

**Prior relaxations:** `RULE-RELAXATION-2026-04-15.md` (the
10-rule set after the pivot from personal-infra to open-source
product).

## What changed

Hard Rule 1 as stated in `RULE-RELAXATION-2026-04-15.md`:

> **No creative work delegation by default.** Bots get correctness
> work; users keep taste work. Creative agents (marketing / growth
> / support) are opt-in plugins with explicit warnings.

The "opt-in plugins" mechanism is future work (Phase 10+ per
DESIGN.md). Ray wants to exercise the *principle* of opt-in
relaxation without waiting for the plugin machinery: gamr gets a
per-project opt-in, nothing else changes.

## Why gamr, why now

gamr was registered 2026-04-18 as a *deliberately mediocre* test
bench for dispatcher generality. On 2026-04-19 morning Ray flipped
the framing after the Claude-generated design turned out
unexpectedly good and the tabletop/wargame matchmaking vertical
showed real market gap (see CLAUDE.md §"Test-project constraints"
for the full framing reversal, and `../gamr/LAUNCH-PLAN.md` for
the phased roadmap).

With gamr as a genuine launch candidate, it becomes the natural
first test for "can the bot do bounded creative work under the
verification gate." The alternative (Ray hand-writes every piece
of copy and every UI label) is the exact bottleneck the tool
exists to eliminate. If the relaxation doesn't work on gamr, we
know the current architecture can't support creative-work
delegation yet. If it does work, we learn how to generalize it
to other projects (or to the eventual plugin system).

Risk is bounded: gamr is pre-launch with no live users, so
bot-produced slop surfaces during review before reaching anyone.
And the verification gate still catches structural violations
(hands-off paths, failing tests, scope drift) even when the task
is creative.

## What the bot can now do (scoped list)

On gamr (not other projects):

- **Write user-facing copy** against a spec Ray provides —
  landing-page hero, about page, FAQ, UI labels, error messages,
  button text. The spec defines *what* is said; the bot picks
  phrasing.
- **Draft marketing posts** for specific channels when Ray gives
  the channel + angle — HN launch draft, r/boardgames post,
  Twitter/X thread. Ray reviews before posting; bot doesn't
  publish.
- **Draft FAQ and help content** against the existing product
  behavior.
- **Choose standard UX patterns** where a canonical solution
  exists and no aesthetic decision is needed — e.g., "paginated
  list with standard controls," "form validation error
  placement per accessibility guidelines."

## What the bot still cannot do (even on gamr)

The Hammerstein invariant — *confident slop is worse than no
work when the commander owns the quality signal* — keeps the
following with Ray:

- **Invent features.** What gamr does is Ray's decision.
- **Decide algorithms.** Matching-compatibility weights, ranking
  logic, pricing structure, ad-network choice stay Ray's.
- **Pick visual design.** Colors, typography, imagery, layout
  aesthetics stay Ray's. (The bot can implement a spec Ray
  writes but can't choose the palette.)
- **Make product strategy calls.** Phase transitions (dev →
  live), launch timing, market positioning, competitive
  comparisons stay Ray's.
- **Override hands-off entries.** `hands_off.yaml` in gamr
  still governs; creative tasks must still stay out of
  `src/lib/matchmaking.ts`, `idea.md`, etc.

## Mechanics

This relaxation is documented prose, not yet enforced in code.
The `gamr/CLAUDE-AUTONOMOUS.md` "Scope for the autonomous bot"
section gets updated alongside this doc so the bot reads the new
rules when it starts a cycle. The `generalstaff/CLAUDE.md`
§"Test-project constraints" block also gets a pointer back here.

No code-level feature flag exists yet. When the "opt-in plugins"
mechanism lands (Phase 10+), this relaxation becomes the reference
case that the mechanism's first plugin implements.

## What this does NOT relax

- Hard Rule 1 for generalstaff, raybrain, or any other current
  or future managed project. Those stay on the default
  "correctness work only" policy.
- Any other Hard Rule. This is a scope expansion within Rule 1,
  not a rewrite of the rule set.
- The verification gate. A creative task still has to pass
  `bun test && bun x tsc --noEmit` (gamr's verification
  command) and stay out of hands-off paths. If writing FAQ
  content accidentally also breaks a test, the gate rolls
  back.

## When to revisit

After gamr ships v0.1.0 or hits 30 days of post-launch operation,
review the relaxation: did the bot produce usable creative output,
or did Ray end up rewriting most of it? If the former, extend to
other projects. If the latter, roll back this doc and wait for the
plugin system + better taste-work architectures.

---

**Effective:** 2026-04-19 morning
**Scope:** gamr only
**Companion:** `../gamr/CLAUDE-AUTONOMOUS.md` §"Scope for the
autonomous bot"; `CLAUDE.md` §"Test-project constraints" in this
repo; `RULE-RELAXATION-2026-04-15.md` for the base rule set
**Owner:** Ray (review + any rollback decision)
