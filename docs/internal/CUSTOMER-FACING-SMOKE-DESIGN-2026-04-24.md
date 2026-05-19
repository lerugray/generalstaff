# Customer-facing smoke gate — design note

*Internal design doc. Drafted from the 2026-04-24 design discussion
(post-rg-017). Draft form — a public-facing writeup, if one is ever
warranted, gets a separate voice pass.*

## Why this doc exists

GeneralStaff's verification gate is good at one thing: confirming a
cycle's diff did not break the bot's own test suite and did not drift
outside declared scope. It is blind to a whole class of failure — a
change that passes every test and still breaks the live product for a
real user. The rg-017 incident made that blind spot concrete. This note
records the incident, names the gap, and specifies the two primitives
that close it.

## (a) The rg-017 incident

Retrogaze ships a hosted product (retrogazeai.com). A cycle landed a
change that shadowed `window.supabase` — the global the front-end uses
to reach its auth + data backend. The change was internally consistent:
it compiled, the unit tests passed, the reviewer saw a scope-matching
diff with no hands_off violations, and the cycle was marked verified.

Nothing exercised the actual login flow. So the regression shipped
silent. It stayed silent through launch. It surfaced only when a real
user — Moontini — hit it: they could not log in, got stuck, and reported
it. By then the broken build had been live long enough to cost real
trust with a paying-adjacent user.

Root cause is not "the bot wrote a bug." Bots write bugs; that is the
premise GeneralStaff is built on. Root cause is that **no gate in the
pipeline loaded the customer-facing surface and tried to use it.** The
verification gate verified the wrong thing — thoroughly.

## (b) What the gate does today, and where it stops

Three checks run per cycle. None of them touches the live product:

- **`verification_command`** runs the project's own test suite. It tests
  what the project's authors thought to test. A regression in an
  untested path — `window.supabase` shadowing being exactly that — sails
  through.
- **The reviewer** checks that the diff matches declared
  `expected_touches` and respects `hands_off`. Scope-match is not
  correctness; the README already says so plainly. The reviewer reads a
  diff, it does not run a browser.
- **The push step** is best-effort and fires after the gate. It moves
  bytes; it does not assert the bytes work.

The gap is structural, not a missing test. Even a project with good
coverage can regress a customer-facing surface through an interaction
its unit tests never simulate (DOM globals, auth round-trips, CDN edge
behavior, hydration order). For a `public_facing` project, "tests pass"
and "the product still works for a logged-in user" are different
Booleans, and GeneralStaff only checked the first.

## (c) The two primitives

The fix is two narrow additions, designed to be independently shippable.

### gs-315 — reviewer-prompt enrichment for `public_facing` projects

A `public_facing: true` flag on `ProjectConfig`. When set, the reviewer
prompt is enriched: the reviewer is told this project has a live
customer-facing surface and is asked to weigh customer-reachable risk
explicitly when it judges a diff. This is cheap, has no runtime
dependency, and raises the reviewer's attention before any hard gate
exists. It must land first so the reviewer is already
`public_facing`-aware when the smoke gate goes live.

*Status: shipped.*

### gs-316 — `customer_facing_smoke` verification step

An optional `customer_facing_smoke?: string` field on `ProjectConfig` —
a shell command. When set, it runs **after** `verification_command`, on
any cycle of a `public_facing: true` project that touched a
customer-reachable surface. If the smoke command exits non-zero, the
cycle's verdict is `verification_failed` — regardless of what the
reviewer concluded. The customer-facing surface gets a Boolean gate of
its own, and a red Boolean is not overridable by prose.

First reference implementation is retrogaze: a Playwright probe that
loads the app (against the live site or a local `docker-compose`
bring-up), asserts `window.supabase` is intact, performs a real login
against a test account, and asserts a 200. The probe — `probe-live.mjs`
— already exists; gs-316 is the harness that makes GeneralStaff run it
as a gate.

*Status: in implementation.*

## (d) Tradeoffs

The design is deliberately conservative because the obvious failure mode
of a smoke gate is worse than the bug it catches.

- **Flakiness vs. missed bugs.** Browser-level smoke tests are flaky:
  network blips, cold edge caches, timing. A flaky *required* gate
  trains operators to ignore red — which is strictly worse than no gate.
  Mitigation: the smoke command owns its own ret/timeout discipline, and
  the field is opt-in per project (see graduation path below).
- **Per-project vs. global.** A single global smoke command cannot
  describe every project's surface. `customer_facing_smoke` is
  per-project: each project supplies the probe that fits its product.
  GeneralStaff supplies the harness and the verdict semantics, not the
  probe.
- **Opt-in vs. required — the graduation path.** `customer_facing_smoke`
  is optional first. A project opts in, runs it advisory-or-required for
  a while, and the gate becomes trusted only once it has demonstrated it
  is not noisy. "Required for all `public_facing` projects" is a
  destination, not a launch state. Forcing it before the harness is
  proven would manufacture exactly the ignore-red habit it is meant to
  prevent.
- **Dependency surface.** A smoke gate pulls a browser driver and a live
  (or locally-stood-up) target into the cycle. That is real weight. It
  is justified only for projects with a live customer surface — which is
  precisely what `public_facing` gates it on.

## (e) catalogdna launch prerequisite

catalogdna does not go public until it has a smoke harness. The gate is
not "catalogdna has unit tests" — it is "an end-to-end probe signs up a
new account and reaches first value, and that probe is wired as
`customer_facing_smoke`." Minimum viable probe: account signup succeeds,
and the new account reaches the product's first real output. Until that
probe exists and passes, a catalogdna cycle marked `verified` is making
the same promise the rg-017 cycle made — and rg-017 is the reason this
doc exists.

## Summary

| Primitive | Adds | Gate strength |
|---|---|---|
| gs-315 | `public_facing` flag → reviewer-prompt enrichment | soft (attention) |
| gs-316 | `customer_facing_smoke` command → post-verification step | hard (Boolean verdict) |

The principle: a `verified` verdict on a `public_facing` project should
mean the customer-facing surface was loaded and used, not merely that
the bot's own tests were green. rg-017 is what the second column buys.
