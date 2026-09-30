CI FIX SUBMITTED mac=fail linux-local=0/0 windows-expected=31 fixed of 37
Environment: macOS arm64, Bun 1.3.13, checkout 6e0cecc; Linux unavailable (0/0 means not run), Windows predictions await CI (Bun 1.3.0).
Full `bun test`: before 2409 pass / 4 skip / 44 fail (2457 total); after 2412 pass / 4 skip / 44 fail (2460 total). Identical failure names, zero new failures.
Full-suite failures are outside verify-only: 42 listener/HTTP failures (loopback bind independently returns EPERM) and two existing STOP/fs.watch failures; hence mac=fail.
Focused verify-only: 147/147 pass; final preflight/cleanup/native-PID checks after the last edits: 4/4 pass. Typecheck and `git diff --check` pass.
Mac lock reproduction command passed in 4.75s locally rather than timing out; its explicit 30s budget now covers the intentional 4s wait plus setup, with every assertion retained.
Windows: 31 expected fixes plus six logged tests scoped to POSIX; the additional TERM-ignoring grace test is also POSIX-only. Timeout, overall-budget, cleanup and native descendant tests remain portable.
Reviewer/vendor/Git stubs use JavaScript sidecars and a cached Bun-compiled native Windows launcher: shell-free spawn cannot execute .cmd directly ([Node docs](https://nodejs.org/download/release/v18.9.0/docs/api/child_process.html)). Windows launcher/taskkill execution still requires CI.
Product fix: bounded native Git tree termination before abort cleanup, one kill attempt per owned PID, errors surfaced; timeout/abort regressions check leader and child death. Natural-exit orphan tracking on Windows is a pre-existing limitation outside these logged failures.
Probe created/read/deleted; supplied CI log deleted; changes uncommitted, no version/release/CHANGELOG changes. Only tests/, src/verify_only/ and this requested report changed.

1. Passing bundled receipt: portable JavaScript reviewer, native Windows executable, PATH delimiter. 2. Hands-off matches/reviewer prompt: portable reviewer.
3. Isolated verification cwd/environment: write native cwd/env from JavaScript; portable reviewer. 4. Human output/read-back: portable reviewer.
5. Dirty checkout/scaffold exclusions: portable reviewer. 6. Reviewer rejection/reason: portable reviewer JSON and configured verdict.
7. Weak reviewer verdict: portable reviewer.
8. Verification timeout/tree reap: native descendant PID capture, explicit test budget; real Bash/taskkill path remains exercised.
9. Reviewer timeout: JavaScript delay, explicit budget, native PID capture and death assertion.
10. SIGTERM during verification/exit 143: POSIX-only signal-handler test; native Windows force-termination cannot deliver it. 11. SIGTERM during reviewer/exit 143: same POSIX-only signal delivery; reviewer timeout/death remains cross-platform.
12. Verification beyond 30 seconds: portable reviewer; original 31-second command/assertions retained.
13. Concurrent identical check: explicit 30-second test budget; lock/refusal/single-cycle assertions unchanged.
14. Dead-owner lock and leftovers: portable reviewer; fixture Git retains Windows system environment. 15. Sequential checks/new cycle: portable reviewer; explicit budget for two CLI cycles.
16. Primary error/fallback provider: portable reviewer. 17. Reviewer quorum: portable reviewer argument/JSON logging.
18. Receipt re-read/digest/state: portable reviewer; explicit budget for three cycles.
19. Round 1 reviewer outside tree: native JavaScript cwd capture and portable reviewer. 20. Round 1 configured global excludes: Git writes its own escaped config; portable reviewer.
21. Round 1 default ~/.config/git/ignore: portable reviewer; hermetic HOME retained. 22. Round 1 cleanup-failure receipt: portable reviewer; explicit subprocess budget.
23. Round 2 real chmod-500 cleanup failure: POSIX-only permission semantics; portable cleanup-event/schema tests retained.
24. Round 2 stalled-child overall budget: fixture Git preserves Windows system environment; PATH uses delimiter.
25. Round 2 preflight cap/reap: native Git shim/PIDs; product taskkill tree fix; five-second setup-inclusive cap still asserted.
26. Round 2 bounded cleanup: executable Git shim and native PID readiness; product tree kill and emergency test cleanup.
27. Round 2 published formula: normalize CRLF solely when comparing the checked-out Markdown text.
28. Round 2 hostile private-key-header diff: portable reviewer; existing redaction/time assertions retained.
29. Round 2 verification-timeout auto-raise: Windows Git environment and reviewer; explicit multi-command test budget.
30. Round 3 SIGTERM preflight: POSIX-only catchable signal test; native abort/tree regression added separately. 31. Round 3 repeated SIGINT/exit 130: POSIX-only signal/trap semantics.
32. Round 5 SIGTERM preflight refusal/exit 143: POSIX-only catchable signal semantics.
33. Round 5 refusal without prune: native executable Git logging shim, portable argv forwarding.
34. Round 5 cycle excludes-Git dies: escaped Git config; round 2 corrects the shim to a fatal Windows exit because self-kill returned the valid unset-key code 1. 35. Round 5 cycle excludes-Git hangs: escaped Git config plus native shim delay and bounded tree kill.
36. Digest vector global-excludes-config: use git config --file to escape native paths.
37. Global excludes resolution/hash: use git config --file; resolver correctly rejected the malformed old fixture.

## Round 2
CI FIX R2 SUBMITTED windows-expected=5/5
1. Passing receipt: fixture scratch uses realpathSync.native, expanding Windows 8.3 names before deriving paths; both receipt path assertions stay exact. The product already canonicalizes checkout and registered paths before comparison/storage (src/verify_only/cli.ts).
2–3. Cycle/bundle excludes-Git death: the shim is selected (both hang cases passed CI); Windows self-SIGKILL returns 1, colliding with Git's valid unset-key exit. Use fatal exit 137 on Windows, retain POSIX SIGKILL, and assert a marker from the exact intercepted command. No resolver change: exit 1 must remain valid. [libuv behavior](https://github.com/libuv/libuv/issues/1133).
4–5. PowerShell idle/empty-log cases: switch to async spawn with concurrently drained stdout/stderr, ignored stdin and -NonInteractive; retain powershell.exe, execution-policy bypass, argv, 20s/30s child deadlines and all outcome assertions. Test budget is 35s to allow cleanup after the longest deadline.
PowerShell diagnosis is inferred: both failures hit 20s while exit-1/2 paths pass in ~1.2s/0.4s, ruling out a missing executable or blanket policy failure. No Windows/PowerShell runtime here to prove the exact pipe/host hang; timeout errors now include stdout, stderr and the script's diagnostic log for CI confirmation.
Validation: focused 60 pass / 4 Windows-only skips / 0 fail; both fatal-exit refusal tests also pass with the Windows numeric-exit branch temporarily forced locally, then restored. Typecheck and diff whitespace check pass.
Full macOS bun test before AND after: 2412 pass / 4 skip / 44 fail (2460 total); identical failure names, zero new failures. These are the same 42 listener/HTTP failures and two STOP/fs.watch failures as round 1, outside verify-only; a clean full-suite pass cannot be claimed here.
Environment probes: loopback bind returns EPERM; raw fs.watch emits no event on creating STOP. Linux and Windows execution unavailable; the four PowerShell tests remain Windows-only.
Probe created/read/deleted first; supplied round-2 CI log deleted. Changes remain uncommitted, limited to tests and this report; no version, release, CHANGELOG or product-script changes.
