# CI is red on master since v0.16.0: make the verify-only suites pass on macOS and Windows (s186)

Grounded: master bb4048a (v0.16.0). GitHub Actions run 36643993151 ("Test"): ubuntu passes; macOS 1 failure; Windows
~37 distinct failures, all in the verify-only suites (tests/verify_only_cycle.test.ts and siblings: "cycle verify: *",
"hardening fix round 1/2/3/5", "receipt re-read", "gs-patch-digest/v1 vector file", "global excludes resolution and
pinning"). The failed-job log is at `.ci-failure-s186.log` in this tree (do not commit it; delete it before you finish).
GeneralStaff promises Windows + macOS + Linux, and src/verify_only already has Windows branches, so skipping the suites
on Windows is NOT the fix unless a specific behaviour is genuinely POSIX-only by design (then say which and why).

## Do
1. **macOS:** "cycle verify: one check per project at a time > a second identical check while one runs is refused and
   starts nothing" hits bun's 5 s default (5030 ms). This Mac is macOS: reproduce it here (`bun test <file> -t ...`),
   then fix the test's timing properly (give it a budget like bb4048a did for the bad-flag test, or remove a real
   wait), never by weakening what it asserts.
2. **Windows:** the fixture puts a fake `claude` POSIX shell script first on PATH with a `:` separator; Windows cannot
   spawn it (`Failed to spawn claude: ENOENT ... uv_spawn 'claude'`) and uses `;`. Make the fixture cross-platform (for
   example a small bun/node script plus a `claude.cmd` shim on win32, `path.delimiter`), including the delay/pid/exit
   behaviours the tests configure (claudeDelay, claudeExit, pid capture). Then read every OTHER Windows failure in the
   log and fix its real cause: fixture assumptions (sh scripts, chmod, /tmp paths) or genuine product bugs in
   src/verify_only on Windows (path separators in the digest or bundle, excludes-file resolution, process-group kill
   semantics). A product bug gets a fix in src plus the test that proves it.
3. Keep Linux and macOS green: run the full suite here (`bun test`) before and after; report totals.

## Rules
- You cannot run Windows here. Reason carefully from the log and the code; list in the report each Windows failure
  and the change you expect to fix it. The seat will open a draft PR so CI runs all three systems, and send you the
  result if anything is still red.
- No version bump, release or CHANGELOG entry. No changes outside tests/, src/verify_only/ and test fixtures unless a
  failure requires it (say so).
- Report `docs/handoffs/ci-portability-s186-REPORT.md` (under 50 lines). First line:
  `CI FIX SUBMITTED mac=<pass|fail> linux-local=<pass/total> windows-expected=<n fixed of m>` or `CI FIX BLOCKED <why>`.
- Leave changes uncommitted in the tree; the seat commits and pushes.
