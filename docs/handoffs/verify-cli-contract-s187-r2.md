# Verify-only CLI contract, round 2 (s187, Astra lane, Mac)

Round 1 (`docs/handoffs/verify-cli-contract-s186.md`, report `verify-cli-contract-s186-REPORT.md`) correctly stopped:
the app seam script `scripts/verify-gate-seam.cjs` (lerugray/generalstaff-desktop @ 0253d0a, branch
`s185/gsd-verify-app`) was written to RECORD today's refusal (line ~29 initialises `realCliSeam='fail'` and never
changes it; line ~38 asserts the gate is `unavailable` with a budget error), and no deterministic reviewer path exists.
The seat accepts that finding. This round removes the false premise instead of stopping on it.

## Part 1 — the CLI fixes (this repo; unchanged from round 1)
Do items 1-5 of the round-1 brief exactly (M4 `--print-budgets --json`, `verificationTreeId`, M2 process ownership +
`--grace`, M3 excludes pin + refuse on mismatch, one-source cleanup-grace docs), with fail-first tests for 1-4 (each
fails on bb4048a, passes after), full battery before/after, backward compatible, no version bump, no CHANGELOG.
None of this depends on the seam: do it first and checkpoint.

## Part 2 — a deterministic reviewer (this repo)
The seam and the Mac sitting may make no model call. Find how the test suite fakes the reviewer (s186's CI work used a
fake reviewer in tests) and expose a DOCUMENTED deterministic reviewer for callers: e.g. a reviewer kind selected by an
existing `GENERALSTAFF_REVIEWER_*` variable that runs a named local command and reads its verdict, or a built-in
`fixed` reviewer that returns a configured verdict. Additive, off by default, clearly labelled as a test/sitting
reviewer in the docs, with tests. Never `claude -p`, never a provider key.

## Part 3 — the app seam's real-CLI leg (a PATCH, not a commit to the app)
In a /tmp clone of the app at 0253d0a, change `scripts/verify-gate-seam.cjs` so the real-CLI leg has an expect-pass mode
(e.g. `SEAM_REAL_CLI=expect-pass`): it drives the real CLI (with Part 2's deterministic reviewer) through the gate and
sets `realCliSeam='pass'` ONLY when every real-CLI assertion held; the existing refusal-recording mode stays the default.
Export it as `docs/handoffs/verify-cli-contract-s187-app-seam.patch` in THIS repo, and write the exact commands to run
it (build steps from the app report's reproduce block, lines ~45-60) into your report.
**Do not run the headed seam or any browser/native window in your sandbox** (the Mac sandbox cannot render; the seat runs
it outside the sandbox after harvest). Unit-check the patched script's logic headlessly if you can; say what you checked.

## Fence
Change only this repo (+ the patch file). No push, no merge, no release, no model calls, no windowed app launch.

## Report
`docs/handoffs/verify-cli-contract-s187-REPORT.md`, under 50 lines. First line:
`CLI CONTRACT SUBMITTED battery=<before>-><after> reviewer=<kind> seam-patch=<ready|none>` or
`CLI CONTRACT BLOCKED <why>`. Include the exact seam commands for the seat.
