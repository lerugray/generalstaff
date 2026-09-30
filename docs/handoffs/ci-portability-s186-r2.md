# CI portability round 2 (s186): five Windows failures left

Your round 1 (cfbef07, PR lerugray/generalstaff#2) turned macOS and Linux green and fixed ~32 of the Windows failures.
GitHub Actions run 36685540993, test (windows-latest), still fails five tests. Full failed-job log: `.ci-failure-r2-s186.log`
in this tree (read it; delete it before you finish; never commit it). Same rules as the round 1 brief
(docs/handoffs/ci-portability-s186.md): fix real causes, keep assertions, POSIX-scope only what is truly POSIX-only.

1. `cycle verify: a passing check > verifies a bundled change and writes a passing verify_only receipt`,
   tests/verify_only_cycle.test.ts:215: Expected `C:\Users\RUNNER~1\AppData\Local\Temp\gs-verify-test-...\project`,
   Received `C:\Users\runneradmin\AppData\Local\Temp\gs-verify-test-...\project`. Windows 8.3 short name vs long name.
   Decide whether the product or the test should canonicalise (fs.realpathSync.native on both sides is the usual test
   fix; if the product stores paths it later compares, canonicalise there too and say why).
2 + 3. `hardening fix round 5 > finding 6: cycle verify refuses when global-excludes git dies` and `... changeset bundle
   refuses when global-excludes git dies`: expected exit 3, received 0 (line 1693), and a promise expected to reject
   resolved (line 1734). On Windows the dying git shim is not the git the CLI runs (PATH/PATHEXT resolution, or the
   shim does not actually die). Find which, and make the test exercise the real refusal path on Windows.
4 + 5. `wait_then_launch_ollama.ps1 > fires immediately when the logs directory is empty` and `... fires when the most
   recent log is already idle past the threshold`: `result.status` is null (tests/wait_then_launch_ollama.test.ts:68, :87).
   These were ALREADY failing on master before your PR (not your regression) but CI cannot be green without them. Read
   the script and test; null status means the child was killed (timeout) or never ran (powershell vs pwsh, execution
   policy, path quoting). Fix the real cause.
Verify here what you can (macOS full `bun test` must stay 0 fail outside your sandbox's loopback limits; say which you
could not run). Append a "Round 2" section to docs/handoffs/ci-portability-s186-REPORT.md with first line
`CI FIX R2 SUBMITTED windows-expected=<n>/5`. Leave changes uncommitted; the seat commits and pushes.
