# Brief: verify-only Windows flake, round 3 (minimal fix), s190, codex Astra

grounded: master 4c1ab99 (verify-only CLI, PR #3) plus 913feec (the stress workflow + output-carrying asserts, cherry-picked
from 6fe5ae7). Rounds 1-2 of this fix live on `origin/s189/ci-verify-stress` (2802849, 80aa2e2) and are ABANDONED: the
Job Objects approach (bun:ffi + a per-call helper process) turned the regular Windows Test workflow RED (5 s timeouts across
many verify tests) where master is green. Read them for context only; do not reuse Job Objects, bun:ffi or a per-call helper.

## The defect (Windows only; Linux and macOS are green)

Evidence: `docs/handoffs/verify-win-reap-r3-ci-evidence-s190.md` (seat extract of the GitHub Actions Windows logs).
On master, the verify-only stress run fails about 2 in 5 passes on windows-latest, with two signatures:
1. `hardening fix round 3 > item 1` expected exit 4 and got exit 3:
   `verify refused (materialize_failed): git could not be started (rev-parse --git-path index)`.
2. `hardening fix round 6 > D2`: `BundleError: git diff --binary exited with code null` (code `git_failed`).
The s189 diagnosis: a git process that actually ran is being reported as "could not be started" or as exit code null. The
likely path is the post-exit reap on Windows (taskkill of a process tree that has already exited, pid not found) being
treated as a spawn failure, and/or reading the exit status before Bun has settled it. Confirm or refute this by reading
`src/verify_only/git.ts`, `runner.ts`, `run.ts`, `materialize.ts`, `bundle.ts` and `windows_process.ts` at your base.

## Your job: the minimal honest fix

- Keep master's taskkill-based reaping. When git has already exited, "not found" from the reap counts as reaped, with a
  bounded proof (the pid is gone), not as a failure.
- A spawn failure, a reap failure and a completed git process must be told apart, each with its own honest code
  (`git_reap_failed` for an unproven reap; never "could not be started" for a process that ran).
- Read the exit status only after the process has settled (`await proc.exited` value, exitCode and signalCode together);
  never report `null` for a git process that finished.
- Add NO per-call process spawns on Windows beyond what master does. Every existing test must stay well under its 5 s timeout.
- Add targeted tests that exercise these paths on any OS with injected fakes (reap reports not-found after exit; exit
  status null before settle then 0), so Linux CI proves the logic; Windows CI proves the platform.
- Do not touch the receipt-reader files `src/cycle_result_v1.ts`, `tests/verify_only_receipt.test.ts` or the
  `cycle result` branch of `src/cli.ts`: that fix is PR #5, landing separately.

## Verify before you finish (on this Linux host)

`bun install --frozen-lockfile`, then the full `bun test` (report pass/fail counts; master is 0 fail here), `bunx tsc --noEmit`,
and the stress loop the workflow runs: `bun test tests/verify_only` five times in a row (report each pass). Windows is judged
by GitHub Actions after the seat opens the PR; you cannot run it, so do not claim it.

## Laws

- No Job Objects, no bun:ffi, no new native dependency, no new per-call helper process.
- Change only what the fix needs; no drive-by refactors. Update `docs/contracts/verify-only-cycle.md` only where a refusal
  code or its wording changes.
- Do not commit or push; the wrapper does. No other repos.

## Final message

First line `R3 READY` or `R3 BLOCKED <reason>`. Then: root cause in two sentences with file:line; files changed; full-suite
counts before -> after; the five stress passes; tsc result. Under 200 words.
