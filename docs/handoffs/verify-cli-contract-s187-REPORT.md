CLI CONTRACT SUBMITTED battery=2451p/2f/4s->2461p/2f/4s reviewer=fixed seam-patch=ready

Grounding: CLI 0778009; fail-first authority bb4048a; temporary app clone 0253d0a. Write probe passed.
M4: side-effect-free JSON budget discovery; verificationTreeId in start/receipt; inherited verification and preflight/cleanup Git groups; --grace honored; explicit excludes path/hash or none with mismatch refusal.
Budgets publish the actual bound: preflightCap + max(overall + grace, preflightReap) + cleanup = 1060 s by default. Cleanup remains 30 s; A1's +5 alone is insufficient. App consumes the published bound plus 60 s.
A1 compatibility change: a Unix verifier must lead its caller-owned group; a shared/unprovable group fails closed instead of detaching. Mac reap/stop/force-kill tested; Linux code supplied, not executed here; Windows Job proof remains unavailable.
Pinned receipts use excludesFilePath/excludesFileSha256; unpinned legacy callers retain globalExcludesFile/globalExcludesSha256. Never emit both pairs: the frozen app aliases them and rejects duplicates.
The opt-in fixed reviewer requires an explicit verdict, records synthetic evidence, suppresses verify-only quorum/fallback model calls, and cannot override failing verification or reap proof. Documented in docs/contracts/verify-only-cycle.md.
Five fail-first cases: 0 pass/5 fail on bb4048a -> 5 pass/0 fail; final contract suite adds fixed-reviewer and caller-stop/background/preflight reap tests.
Full before/after: SAME two existing failures (engineer STOP-before-spawn; stop_watcher real-fs.watch). No new failures. Calibration skips real providers. Initial dependency-missing run was discarded; frozen-lockfile install used /private/tmp.
Validation: typecheck PASS; inherited-Git/shutdown suite 18/0; earlier verify-only suite 151/0; final full suite includes all 10 new contract cases. Lock-test deadline corrected to cover its existing 20 s readiness wait plus 4 s command.
Logs: /private/tmp/gs-s187-{before-valid,after-final,red-bb4048a,owned-git,typecheck-final}.log. Part-1 checkpoint: /private/tmp/gs-s187-part1-checkpoint.tgz (before reviewer work; no commit).
Patch: verify-cli-contract-s187-app-seam.patch, one app script only. Default records refusal; expect-pass uses real CLI/fixed reviewer, checks bound evidence, reap, reopen, stale edit, exit 7, corruption, 121 s check, and unchanged HEAD/index/config before setting pass.
The frozen app request builder lacks pin flags; this seam's wrapper supplies the explicit pin. Production app pin transport needs the equivalent follow-up. This patch does not claim a completed Mac sitting.
Headless checks: patch apply, node --check, and --self-test (valid receipt, rejected invalid binding/reap/provider/evidence/state, and every incomplete pass-latch input). No native build, browser, Tauri window, audio, or real seam run here.
No model calls, keys used, commit, push, merge, version bump or CHANGELOG. Changes remain in the working tree; all foreground commands finished.

Seat commands, from this CLI root, OUTSIDE the sandbox (native-broker/browser seam; derived from the app report's reproduce block):
```sh
CLI_ROOT="$(pwd)"
SEAM_APP="$(mktemp -d /private/tmp/gs-s187-seat.XXXXXX)"
git clone https://github.com/lerugray/generalstaff-desktop.git "$SEAM_APP"
git -C "$SEAM_APP" checkout --detach 0253d0a
git -C "$SEAM_APP" apply "$CLI_ROOT/docs/handoffs/verify-cli-contract-s187-app-seam.patch"
cd "$SEAM_APP"
npm install --prefix /private/tmp/s187-seat-tools playwright@1.48.2 bun
/private/tmp/s187-seat-tools/node_modules/.bin/playwright install chromium
cargo build --manifest-path src-tauri/Cargo.toml --example verify_gate_seam
python3 - "$CLI_ROOT/src/cli.ts" <<'PY'
import pathlib, shlex, sys
p = pathlib.Path('/private/tmp/s187-seat-tools/generalstaff')
p.write_text('#!/bin/sh\nexec /private/tmp/s187-seat-tools/node_modules/.bin/bun run '+shlex.quote(sys.argv[1])+' "$@"\n'); p.chmod(0o700)
PY
node scripts/verify-gate-seam.cjs --self-test
PW_MODULE=/private/tmp/s187-seat-tools/node_modules/playwright GS_SEAM_CLI=/private/tmp/s187-seat-tools/generalstaff SEAM_REAL_CLI=expect-pass SEAM_SLOW_SECONDS=121 node scripts/verify-gate-seam.cjs
```
Success artifact: docs/verification/verify-gate-app-s185/seam.json with realCliSeam=pass and fixtureSeam=pass; screenshots live beside it. Browser is muted by the script.
