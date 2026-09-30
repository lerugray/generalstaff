# Windows CI evidence for the verify-only reap flake (s190 seat extract)

## Master baseline (run 36728269304, stress on e594fb0 = master code + stress workflow + output-carrying asserts): 2 of 5 Windows passes failed
```
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7028332Z 1413 |         "test",
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7028844Z 1414 |       );
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7029596Z 1415 |       // Carry the captured output so an unexpected exit code says why (a refusal names its code).
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7030835Z 1416 |       expect({ code, stdout: stdout.join(""), stderr: stderr.join("\n") }).toMatchObject({ code: 4 });
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7031747Z                                                                                   ^
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7032402Z error: expect(received).toMatchObject(expected)
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7032824Z 
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7032960Z   {
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7033351Z -   "code": 4,
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7033728Z +   "code": 3,
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7034567Z +   "stderr": "generalstaff: verify refused (materialize_failed): git could not be started (rev-parse --git-path index)",
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7035561Z +   "stdout": 
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7036743Z + "{"schemaVersion":"cycle-verify/v1","refused":true,"state":"refused","cycleId":null,"reason":"materialize_failed","message":"git could not be started (rev-parse --git-path index)"}
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7038018Z + "
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7038353Z + ,
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7038694Z   }
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7038897Z 
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7039105Z - Expected  - 1
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7039487Z + Received  + 6
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7039685Z 
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7040158Z       at <anonymous> (D:\a\generalstaff\generalstaff\tests\verify_only_cycle.test.ts:1416:76)
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:00.7127946Z (fail) hardening fix round 3 > item 1: a forced write failure in preflight leaves no worktree, no git worktree list entry and no cycle directory [859.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:08.3997363Z (pass) hardening fix round 3 > item 1: the preflight cap firing after the cycle directory exists leaves no worktree and no cycle directory [7688.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:08.3998633Z (skip) hardening fix round 3 > item 2: SIGTERM aborts preflight and no live git process survives
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:08.3999424Z (skip) hardening fix round 3 > item 2: preflight SIGINT exits 130 with no surviving git, even when git traps SIGINT and another is sent
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:09.6552196Z (pass) CLI help > documents the verify flags, exit codes and the absence of a model flag [1266.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:09.6553545Z (skip) hardening fix round 5 > finding 1: SIGTERM during preflight reports interrupted, exit 143, no receipt or debris
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:11.1796903Z (pass) hardening fix round 5 > finding 2: a refusal before tree creation spawns no git worktree prune [1515.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:12.2336586Z (pass) hardening fix round 5 > finding 5: preflight cleanup preserves a cycle created concurrently in its parent [1063.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:13.8549725Z (pass) hardening fix round 5 > finding 6: cycle verify refuses when global-excludes git dies [1609.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:37:14.3266707Z (pass) hardening fix round 5 > finding 6: changeset bundle refuses when global-excludes git dies [484.00ms]
```

## D2 failure in the same baseline run
```
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:22.5439905Z (pass) hardening fix round 1 > an unproven reap fails the check even when the exit code was 0
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:24.4932474Z (pass) hardening fix round 1 > a worktree cleanup failure is reported on the record, not silent [1953.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:24.4933362Z (skip) hardening fix round 2 > item 1: cleanupFailed round-trips writer -> schema -> reader when a real worktree removal fails
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:24.4937172Z (pass) hardening fix round 2 > item 1: the schema declares verify.cleanupFailed as a boolean, and the contract docs list it
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:25.7745467Z (pass) hardening fix round 2 > item 2: an unproven reap in the real verification stage fails the check and is recorded [1282.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:29.9841235Z (pass) hardening fix round 2 > items 3 and 6: a stalled child ends inside the published budget; the abort waits grace, not grace + 5 s [4203.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:35.8257112Z (pass) hardening fix round 2 > items 5 and 6: the preflight cap fires, stops and reaps the in-flight git, then refuses cleanly [5843.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:36.6584822Z (pass) hardening fix round 2 > item 5: cleanup itself is bounded when git stalls [829.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:36.6588581Z (pass) hardening fix round 2 > item 4: the published formula matches what the code bounds
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:38.5849638Z (pass) hardening fix round 2 > item 4: a hostile diff full of unterminated private-key headers is redacted in bounded time [1937.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:39.9740388Z (pass) hardening fix round 2 > item 7: --help and the refusal name the overall-timeout minimum and how to fix the call [1375.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:42.6714270Z (pass) hardening fix round 2 > item 7: giving only --verification-timeout raises the default overall budget instead of refusing [2703.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:43.7529755Z (pass) hardening fix round 3 > item 1: a forced write failure in preflight leaves no worktree, no git worktree list entry and no cycle directory [1078.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:51.4724646Z (pass) hardening fix round 3 > item 1: the preflight cap firing after the cycle directory exists leaves no worktree and no cycle directory [7719.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:51.4725837Z (skip) hardening fix round 3 > item 2: SIGTERM aborts preflight and no live git process survives
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:51.4726586Z (skip) hardening fix round 3 > item 2: preflight SIGINT exits 130 with no surviving git, even when git traps SIGINT and another is sent
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:52.7484217Z (pass) CLI help > documents the verify flags, exit codes and the absence of a model flag [1281.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:52.7485039Z (skip) hardening fix round 5 > finding 1: SIGTERM during preflight reports interrupted, exit 143, no receipt or debris
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:54.2292454Z (pass) hardening fix round 5 > finding 2: a refusal before tree creation spawns no git worktree prune [1485.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:55.3270719Z (pass) hardening fix round 5 > finding 5: preflight cleanup preserves a cycle created concurrently in its parent [1093.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:56.9222368Z (pass) hardening fix round 5 > finding 6: cycle verify refuses when global-excludes git dies [1594.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:57.3815152Z (pass) hardening fix round 5 > finding 6: changeset bundle refuses when global-excludes git dies [453.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:33:59.3532909Z (pass) hardening fix round 5 > finding 6: cycle verify refuses when global-excludes git hangs [1985.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.2612024Z (pass) hardening fix round 5 > finding 6: changeset bundle refuses when global-excludes git hangs [906.00ms]
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7501911Z 
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7542887Z ##[error]
stress (windows-latest)	Run the verify-only tests repeatedly	      at writeBundle (D:\a\generalstaff\generalstaff\src\verify_only\bundle.ts:208:13)
stress (windows-latest)	Run the verify-only tests repeatedly	      at async <anonymous> (D:\a\generalstaff\generalstaff\tests\verify_only_cycle.test.ts:1767:24)
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7558149Z 203 |     );
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7558534Z 204 |     if (transport.truncated) {
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7559214Z 205 |       throw new BundleError("diff_too_large", "the tracked patch is too large to bundle");
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7559897Z 206 |     }
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7560244Z 207 |     if (transport.code !== 0) {
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7560972Z 208 |       throw new BundleError(
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7561343Z                   ^
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7561759Z BundleError: git diff --binary exited with code null
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7562231Z  code: "git_failed"
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7562424Z 
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7562782Z       at writeBundle (D:\a\generalstaff\generalstaff\src\verify_only\bundle.ts:208:13)
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7563737Z       at async <anonymous> (D:\a\generalstaff\generalstaff\tests\verify_only_cycle.test.ts:1767:24)
stress (windows-latest)	Run the verify-only tests repeatedly	2026-09-30T14:34:00.7626302Z (fail) hardening fix round 6 > D2: an unwritable progress log after start keeps stdout to one JSON line [500.00ms]
```

## Rounds 1-2 (Job Objects via bun:ffi, per-call helper): regular Test workflow went RED on Windows (it was green on master)
Run 36740387594 (80aa2e2), Windows failing tests:
```
```
