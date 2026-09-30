# Brief r2: Windows reap fix — two adversarial-review findings (s189)

grounded: branch s189/ci-verify-stress @ 2802849 (round 1: Job Objects via bun:ffi, git_reap_failed code); round-1
brief docs/handoffs/verify-win-git-reap-fix-s189.md still applies (anti-goals, gates). A read-only Astra review
returned FIX-FIRST with the two findings below; the seat confirmed both against the code.

You are lane verify-win-reap-r2-s189 on branch s189/ci-verify-stress. Write probe first.

## Finding 1 (REAL): a stuck launcher can outlive its timeout indefinitely
`src/verify_only/windows_process.ts` ~67: after the first stop, a later stop only calls `job.terminate()`. If the
helper hangs before joining the job and taskkill fails, terminating the (empty) job cannot kill it.
`src/verify_only/git.ts` ~390 and `src/verify_only/runner.ts` ~186 start stopping but never force completion without
an exit event, so both promises can stay pending past their deadlines. `tests/verify_only_windows_reap.test.ts` ~69
masks this by marking the launcher exited even when taskkill fails.
**Fix:** direct termination of the launcher itself on the retry path, and a bounded completion deadline that resolves
with `reaped: false` (fail closed) instead of waiting forever. Test: a launcher that never emits exit/close must
resolve by its deadline as not reaped; the existing test must no longer fake an exit when taskkill fails.

## Finding 2 (REAL, pre-existing): cleanup discards an unproven git reap and can still return a pass
`src/verify_only/materialize.ts` ~244-261: the cleanup `git worktree remove` and `git worktree prune` results are
discarded; only directory absence is checked. So `src/verify_only/run.ts` ~517 can keep `passed: true` and
`reaped: true` with a surviving cleanup process or a failed native query, contradicting
`docs/contracts/verify-only-cycle.md` ~246.
**Fix:** propagate cleanup reap failures into the final result and receipt (reaped false, an honest reason), and do
not write the passing terminal record until cleanup ownership is proven. Test on every OS with a mocked cleanup git
result whose reap is unproven: the receipt must not read passed + reaped.

## Gates, limits, report
Same as round 1: full `bun test` counts before/after, `bun test tests/verify_only` three times green, typecheck
clean, no retries/skips/raised timeouts, src/safety.ts untouched, no commit, no push. The seat runs the Windows
stress job as the real gate. Report under 250 words: each finding fixed how, files, counts, anything unverifiable
without Windows.

## Finding 3 (REAL, from the s189 Mac sitting): `cycle result` crashes on unreadable receipt evidence
`generalstaff cycle result <id>` throws an uncaught `EISDIR` from `getCycleResultV1` (`src/cycle_result_v1.ts` ~569,
`readFile(digestInputAbs)`) when a cycle artifact is unreadable (here `digest-input.bin` replaced by a directory). It
exits 1 with a Bun stack trace. **Fix:** catch read failures of every receipt artifact and return a structured refusal:
nonzero exit, one clean stderr line such as `receipt evidence unreadable: digest-input.bin (EISDIR)`, and with `--json`
a JSON error object; never a stack trace. Keep fail-closed (never a receipt that reads as passed). Test on every OS
with a directory in place of each artifact the reader opens.
