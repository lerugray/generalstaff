# Brief: Windows verify-only flakes — a git reap-proof failure is reported as "git could not be started" (s189)

grounded: master 4c1ab99 (#3 merged); this branch s189/ci-verify-stress adds `.github/workflows/stress.yml`
(verify-only tests x5 per OS on pull requests) and makes two exit-code asserts print captured output.

You are lane verify-win-reap-s189 on branch s189/ci-verify-stress. Start with a write probe (create and delete
`docs/handoffs/.write-probe`); if it fails, stop and say so. Run `bun install --frozen-lockfile` first.

## Evidence (Windows CI only; macOS and Ubuntu green; each passes on rerun)

1. master 4c1ab99, run 36724993167: `tests/verify_only_cycle.test.ts` "hardening fix round 6 > D2: an unwritable
   progress log after start keeps stdout to one JSON line": expected exit 4 (internal), received 3 (refused).
   Rerun of the same job passed.
2. PR #4 run: `tests/verify_only_bundle.test.ts` "refuses a missing, extra or altered bundled file" hit the 5 s test
   timeout after bun reported "killed 1 dangling process".
3. PR #4 run: `gs-patch-digest/v1 vector file > vector untracked-empty-file` failed with
   `DigestError: git could not be started (rev-parse --git-path index)`, code `git_missing`, from
   `gitFailure` (src/verify_only/digest.ts:208) via `withPrivateIndex` (digest.ts:271).
4. Earlier on #3: `fixed reviewer is explicit ...` received exit 143 on Windows (abd3bee).

## The seat's reading (verify it; do not take it on trust)

`runGitRawInner` (src/verify_only/git.ts ~335-395) calls `releaseGitGroup(child.pid)` after git exits and, if that
returns an error, writes it into `result.spawnError`. On Windows `releaseGitGroup` uses `taskkill /PID <pid> /T /F`
(git.ts ~195-250) and records failures in `windowsTreeKillErrors`. So a git that ran fine but whose tree-release
step failed (taskkill racing the exit, taskkill itself failing or slow under CI load, a PID already gone) is
reported as "git could not be started", mapped to `git_missing`, and becomes a refusal (exit 3). The same path
can plausibly produce the dangling-process timeout and the 143.

## What to do

1. Confirm or refute the reading from the code. Name the exact sequence that turns a successful git run into
   `spawnError` on Windows, and every other place this pattern exists (git.ts, runner.ts ~48, excludes.ts).
2. Fix the root cause so a git process that started and exited is never reported as not started:
   - a release/reap failure gets its own honest code and message carrying the underlying cause (taskkill exit
     code / error text); it must never masquerade as `git_missing`;
   - the Windows reap proof must be correct for the normal case (git already exited, tree already gone ->
     "reaped", not an error), including taskkill's "process not found" exit, and must still fail closed when a
     live descendant genuinely survives (the safety contract stays: unproven reap is not a pass);
   - include the underlying error text in every `DigestError`/`VerifyRefusal` built from a git failure.
3. Add deterministic tests for the new behaviour that run on every OS (mock the taskkill/`spawnSync` result or the
   release function; no sleeps, no timing races). They must fail on the old code and pass on the new.
4. Anti-goals: no test retries, no `it.skip`/platform skips added for these tests, no raised test timeouts as the
   fix, no weakening of the reap/fail-closed contract, no changes to the autonomous cycle path (src/safety.ts).

## Gates (run them; report counts)

- `bun test` full suite on this machine: before -> after counts (pass/fail/skip).
- `bun test tests/verify_only` three times in a row: all green.
- `bun run typecheck` clean.
- Do not push and do not commit. The seat commits, pushes, and runs the Windows stress job (5 passes) as the
  real gate.

## Report (last message, under 300 words)

The confirmed cause (or what you found instead), the fix in plain terms, files changed, test counts before/after,
and anything you could not verify without Windows.
