# Verify-only CLI: meet the desktop app's gate contract (s186)

Grounded: public master bb4048a (v0.16.0, released 2026-09-29: `cycle verify`, changeset bundle, `cycle result --json`;
hardening ba6dd10). The desktop app's verify-gate half is built and tested against controlled fixtures
(lerugray/generalstaff-desktop, branch `s185/gsd-verify-app` @ 0253d0a) but its REAL-CLI seam fails against this CLI.
Its report, `docs/handoffs/verify-gate-app-half-s185-REPORT.md` line 43, lists the CLI defects; the contract is the
app spec `docs/specs/verify-only-gate-2026-09-29.md` as amended by `docs/specs/verify-only-gate-2026-09-29-A1.md`
(A1 wins where they differ). Clone that repo read-only into /tmp to read them; you change only THIS repo.

## Fix, in this CLI (src/verify_only/* and its docs), exactly per A1
1. **M4 budgets:** `generalstaff cycle verify --print-budgets --json` prints the published worst case (preflight cap,
   overall verify budget, reviewer budget, cleanup grace, whatever A1 M4 lists) as JSON, no side effects, exit 0.
   Today it is rejected as an unknown option (cli.ts option parsing).
2. **verificationTreeId:** the start output (cli.ts ~360-372) and the receipt (run.ts) carry `verificationTreeId` as
   the app spec defines it, so the app can prove it owns and reaped the tree.
3. **M2 process ownership:** the CLI must not detach the verification command into its own session
   (`runner.ts:134 detached: !isWindows`); accept `--grace=<seconds>` and honour it; the caller's group kill must reach
   every descendant. Keep a proven reap (ba6dd10) on the CLI's own timeouts.
4. **M3 excludes pin:** accept the caller's pinned global-excludes resolution (A1 M3: the file path and its hash, or
   explicit none) and REFUSE on mismatch instead of silently re-resolving; custom `XDG_CONFIG_HOME` must not break a
   pinned call.
5. **Cleanup grace docs:** public docs publish +30 s, A1 names +5 s. Make the docs state the real published worst case
   from item 1 (one source of truth), and reconcile per A1.

Backward compatibility: every change additive or behind the new flags; a v0.16.0 caller without them behaves as today
unless A1 requires otherwise (say so in the report). No version bump, no release, no CHANGELOG entry (release is a
separate gate).

## Proof
- Fail-first tests for items 1-4 (each fails on bb4048a, passes after). Full battery before/after (`npm test` or the
  repo's documented command); report totals; no new failures.
- **Real seam:** in /tmp, clone the app at `s185/gsd-verify-app`, build what its report's reproduce block needs, and
  run `scripts/verify-gate-seam.cjs` with `GS_SEAM_CLI` pointing at THIS repo's CLI (the report's commands, lines 45+).
  Target `seam.json` realCliSeam=pass. No model calls: use the deterministic reviewer path the report describes (no
  `-p`, no provider keys). Headless browser with `--mute-audio` (or Xvfb if the seam needs headed).
- Report `docs/handoffs/verify-cli-contract-s186-REPORT.md` (under 50 lines). First line:
  `CLI CONTRACT SUBMITTED seam=<pass|fail> battery=<before>-><after>` or `CLI CONTRACT BLOCKED <why>`.
No merge, no push, no deploy; leave changes in the tree (the wrapper commits).
