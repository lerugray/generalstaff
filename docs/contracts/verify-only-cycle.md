# Verify-only cycle

`generalstaff cycle verify` checks a snapshot of someone's own uncommitted
change and writes a [`cycle-result/v1`](./cycle-result-v1.md) receipt bound to
that snapshot. It runs the project's verification command and the reviewer, and
nothing else. It never runs an engineer, the advisor, the judgment gate,
mission-swarm or any bot, and it never writes to the checkout it was given.

`generalstaff changeset bundle` makes the snapshot. Together they work with no
other tooling: bundle a dirty checkout, verify it, read the receipt.

```
generalstaff changeset bundle --checkout=/work/app --base=$(git -C /work/app rev-parse HEAD) --out=/tmp/app-bundle
generalstaff cycle verify --project=app --checkout=/work/app --base=<same sha> --branch=main \
    --bundle=/tmp/app-bundle --digest=sha256:<printed by bundle> --digest-algorithm=gs-patch-digest/v1 --json
generalstaff cycle result <cycle-id> --json
```

The receipt is the only verdict. The exit code of `cycle verify` is a
convenience; a caller that binds a check to a change reads the receipt.

## `generalstaff cycle verify`

| Flag | Meaning |
| --- | --- |
| `--project=<id>` | Registered project id. Its registered path must be `--checkout`. |
| `--checkout=<abs path>` | The checkout the snapshot was taken from. Absolute, no `.` or `..` segments. Must be the git top level. Read-only for this command. |
| `--base=<hex>` | The commit the snapshot was taken against. Full 40 (or 64) lowercase hex characters; must be a commit in the checkout. |
| `--branch=<name>` | Recorded identity only. No branch is created, moved or checked out. |
| `--bundle=<abs dir>` | The snapshot directory. Absolute, outside the checkout. |
| `--digest=sha256:<64 hex>` | The digest the bundle must reproduce. |
| `--digest-algorithm=gs-patch-digest/v1` | Names the digest contract ([gs-patch-digest-v1.md](./gs-patch-digest-v1.md)). Required. |
| `--exclude=<path>` | Repeatable. Repo-relative paths left out of the snapshot. Must match how the bundle was made. |
| `--json` | Write one machine-readable object to stdout (see below). |
| `--verification-timeout=<s>` | Budget for the verification command, all stages together. Default 600. |
| `--reviewer-timeout=<s>` | Budget for the reviewer. Default 300. |
| `--overall-timeout=<s>` | Budget for the whole check after it starts. Default 900; must be at least `--verification-timeout` + `--reviewer-timeout` (lower is refused, exit 3, no receipt). When it is omitted and either of those two is given, the default is raised to their sum if that is larger than 900. |
| `--print-budgets` | Print the budget object without starting a check; requires no project flags. |
| `--excludes-file=<path or none>` / `--excludes-file-sha256=<hash or empty>` | Optional pair. Use this exact resolution; refuse missing/unreadable/changed bytes (`excludes_mismatch`, exit 3). Explicit none ignores ambient HOME/XDG/config. Omit both for legacy local resolution. |
| `--grace=<s>` | Wait between the polite stop signal and the force kill. Default 10. |

There is no model, provider or runner flag. The reviewer is chosen by the
project's configuration and the user's own `GENERALSTAFF_REVIEWER_*`
variables, exactly as for an autonomous cycle. The receipt records the provider
that actually ran.

### Deterministic test/sitting reviewer

For a local integration test with no model calls, set both:

```sh
export GENERALSTAFF_REVIEWER_PROVIDER=fixed
export GENERALSTAFF_REVIEWER_FIXED_VERDICT=verified
```

Accepted verdicts: `verified`, `verified_weak`, `verification_failed`. The mode
is off by default. It returns that configured verdict, **does not review scope
or correctness**, calls no model, needs no key, and starts no reviewer process.
Missing/invalid verdicts fail closed and never invoke a fallback provider.
On the verify-only path this explicit mode also suppresses configured quorum
providers. Receipts identify `reviewerProvider: "fixed"`; normal prompt,
response and verdict evidence is still written and labels the synthetic review.
A fixed approval cannot override failing verification, digest mismatch or
unproven reap. Use only for tests/sittings, never as evidence of a real review;
unset both variables when finished. Default reviewers are unchanged.

### Time budgets

`generalstaff cycle verify --print-budgets --json` is the authoritative,
side-effect-free discovery call, including outside a registered root. It returns
`{schemaVersion:"cycle-verify-budgets/v1", budgets:{preflightCap, overall,
verification, reviewer, grace, cleanup, preflightReap, worstCaseWallClockSec,
formula}}`. All numeric values are seconds. Timeout/grace overrides are honored
by the probe; `run.ts:publishedVerifyBudgets` and `worstCaseWallClockSec` supply
both the probe and the lock calculation. Supervisors must consume this output.

The budgets interact in these fixed ways:

- The overall budget is the hard limit, so it must cover the stages it
  contains: the CLI refuses an `--overall-timeout` below
  `--verification-timeout` + `--reviewer-timeout` (a preflight refusal, exit 3,
  before anything is recorded; the message names the minimum and the fix). An
  omitted `--overall-timeout` is raised to that sum when it would otherwise be
  smaller; an explicit one is never changed. A check can always fail inside a
  stage instead of being cut mid-record.
- Everything before the overall timer starts runs under one hard cap of 120
  seconds: the leftover sweep, checkout probes, global-excludes resolution,
  digest recompute, worktree materialization, the review diff, secret
  redaction and the `digest-input` / `diff.patch` writes. A breach is a
  preflight refusal (exit 3): the in-flight git (its process groups included)
  is killed and reaped, then the partially materialized tree is removed.
- After the overall timer fires, the check waits at most `--grace` seconds for
  the verification runner to finish its own kill, then force-kills every group
  it owns and records the terminal `cycle_end`.
- Cleanup of the worktree is three steps (`git worktree remove`, directory
  removal, `git worktree prune`) of at most 10 seconds each: 30 seconds.
- The real worst-case wall clock is therefore
  `preflightCap + max(overall + grace, preflightReap) + cleanup` seconds
  (defaults: `120 (preflight cap) + overall + grace + 30 (cleanup)`, 1060 s).
  The +5-second allowance in Amendment A1 is a minimum, not enough for the
  existing three cleanup steps. The published actual bound retains +30;
  clients must use `worstCaseWallClockSec` plus their margin (default 60 s),
  never hardcode +5. A caller
  that supervises the process should give it strictly more than that so the
  check can write its terminal record and clean up. The `.lock`
  time-to-live uses the same published bound plus 90 seconds.

### Exit codes

| Code | Meaning | Receipt |
| --- | --- | --- |
| 0 | The check ran and passed (`verified` or `verified_weak`) | yes |
| 1 | The check ran and did not pass | yes |
| 2 | Usage error: a missing, malformed or unknown flag | no |
| 3 | Preflight refusal (below) | no |
| 4 | Internal error, including a progress-log write failure after `cycle_start` | may be absent or lack a terminal record |
| 128+N | Interrupted by signal N after `cycle_start` | yes, unless the progress log becomes unwritable or a second signal forces exit |
| 128+N | Interrupted by signal N before `cycle_start`; refusal JSON with reason `interrupted` | no |

### `--json` output

Exactly one line on stdout; everything else goes to stderr.

Started (written after the startup events are recorded, before verification runs):

```json
{"schemaVersion":"cycle-verify/v1","cycleId":"20260929155314_nt3x","projectId":"app","state":"running","mode":"verify_only","verificationTreeId":12345}
```

Refused (exit 2, 3 or 4, or 128+N, when no start object was emitted):

```json
{"schemaVersion":"cycle-verify/v1","refused":true,"state":"refused","cycleId":null,"reason":"digest_mismatch","message":"..."}
```

Exit 2 and preflight refusals record no cycle. An internal error or interruption
while appending startup events can leave `cycle_start` recorded before the start
object is emitted; the refusal object then still has `cycleId: null`. If an
exception escapes after the start object was emitted, stdout keeps that single
start line and the error goes only to stderr (exit 4, or 128+N if a signal was
seen). The check attempts `cycle_end`, but an unwritable `PROGRESS.jsonl` can
prevent it, leaving the receipt without a terminal verdict. The start object
is never a verdict.

A refusal also prints one scrubbed line to stderr:
`generalstaff: verify refused (<reason>): <message>`.

### Preflight refusals

Each is a stable `reason` code. None records a cycle.

| Reason | Cause |
| --- | --- |
| `invalid_argument` | a bad or missing flag value |
| `project_not_registered` | unknown id, unloadable `projects.yaml`, or the checkout is not that project's registered path |
| `checkout_invalid` | not a directory, or not the top level of a git work tree |
| `base_unresolvable` | `--base` is not a commit in the checkout |
| `bundle_missing` / `bundle_empty` / `bundle_unreadable` | no bundle, an empty directory, or a malformed one |
| `bundle_escapes` | a symlink, a `.git` entry, or a path that would land outside the worktree |
| `bundle_extra_files` | bundled files that are not part of the change-set (for example files git ignores) |
| `snapshot_limit` | a file, file count or patch over the caps |
| `unsupported_digest_algorithm` | any id other than `gs-patch-digest/v1` |
| `digest_mismatch` | the bundle does not reproduce `--digest` |
| `excludes_mismatch` | caller-pinned global excludes bytes no longer match; no check starts |
| `empty_patch` | the change-set is empty |
| `no_verification_command` | the project has no verification command |
| `verify_in_progress` | another check is running for this project |
| `materialize_failed` | the isolated worktree could not be built or the patch did not apply |
| `interrupted` | a signal stopped preflight before `cycle_start` (exit 128+N) |
| `internal_error` | anything unexpected |

## The bundle

```
<bundle>/diff.patch   tracked side: `git diff --binary` against the base commit
<bundle>/files/...    a byte copy of every untracked, non-ignored, non-excluded file
                      at its repo-relative path
```

The bundle carries no digest of its own; the caller supplies the expected one.
Other top-level entries are ignored. A reader refuses symlinks, `.git`
entries, non-regular files, and any file outside the change-set.
`generalstaff changeset bundle` writes only inside `--out`, which must not exist
or must be empty, and must be outside the checkout. It reads the checkout
without touching its working tree, index or refs, refuses an empty change-set,
and fails (removing what it wrote) if the checkout changes while the snapshot
is taken.

## What a check does

1. Validates the request and resolves the project. Any failure is a refusal.
2. Takes the project's verify lock (`state/<project>/verify/.lock`) and sweeps
   leftovers of an earlier check that died.
3. Builds an isolated detached worktree at
   `state/<project>/verify/<cycle-id>/tree`: prune, `git worktree add --detach`,
   `git apply --index` of `diff.patch`, copy `files/` in. Git hooks and
   fsmonitor are disabled for every call. The caller's working tree, index, HEAD
   and branches are not touched; the only writes to the caller's repository are
   git worktree metadata.
4. Recomputes the [gs-patch-digest/v1](./gs-patch-digest-v1.md) digest inside
   the worktree and compares it with `--digest`. This is the binding guarantee.
5. Records `cycle_start`, `worktree_preflight`, `diff_summary`, then runs the
   verification command (and, when configured, the project's player-path,
   claim-battery and customer-facing smoke stages, in the usual sequence), then the
   reviewer, appending the usual `PROGRESS.jsonl` events.
6. Writes one `cycle_end` (pass, fail, timeout, signal, internal error), then
   removes the worktree. A progress-log write failure or a second signal can
   prevent the terminal record.

Not run, and not reachable: the engineer, advisor, judgment gate, mission-swarm
preview, creative routing, work detection, branch reset/merge/accumulate, the
failure rollback, the state auto-commit, fleet counters, `.bot-worktree`
cleanup, and the gates that police agent edits (JSON syntax, state wipe,
engineer exit). A runtime guard makes the agent entry points throw while a
check is active, and the verify modules do not import them.

Hands-off matches are recorded, not enforced. The checked change is a person's
own; `verify.handsOffHits` lists the matches, and the reviewer is told about
them as scope context. The autonomous cycle's hard hands-off gate is unchanged.

### Process ownership

The verification command inherits the CLI's process group: it does not detach. `verificationTreeId` in start output and the terminal `verify`
block is that group id (the supervised CLI PID). On Unix the caller must launch
the CLI as group leader (e.g. Node `spawn(..., {detached:true})` or a foreground
shell job). The CLI refuses to run a command in a shared group it cannot safely
sweep. This is the A1-required compatibility change for unsupervised/shared-group
callers; it prevents killing unrelated siblings. macOS uses a group-scoped
kernel enumeration; Linux reads `/proc`. Enumeration failure fails closed.
On timeout/abort, members receive TERM, then KILL after `--grace` seconds;
the CLI remains alive to write its receipt. Normal completion also sweeps and
proves the group empty except for the CLI itself. Caller group termination
therefore reaches verification descendants, including grandchildren, and all
preflight/cleanup Git children of a supervised verify call. Standalone bundle
helpers retain their existing owned Git groups. Commands
must not deliberately escape the owned group with setsid/setpgid. Windows still
uses taskkill tree cleanup; no Windows Job-Object proof is claimed here.
A process group that could not be *proven* reaped fails the check
(`verify.reaped` is `false`, category `verification_error`): a surviving group
may still be running commands against operator state, and must never read as a
pass. If the worktree cannot be removed after the check, a
`verify_cleanup_failed` event is appended to the cycle's `PROGRESS.jsonl` and a
warning goes to stderr; the next check for the project sweeps the leftover.
The command's environment is a small pinned set (`PATH`, `HOME`, locale,
temp-dir variables, `GENERALSTAFF_VERIFY_ONLY=1`, `GENERALSTAFF_CYCLE_ID`);
other variables of the calling process, including reviewer credentials, are not
passed unless named in `GENERALSTAFF_VERIFY_ENV_PASSTHROUGH` (comma separated).
The reviewer process keeps the calling environment, as always, but runs from
the cycle's verify directory — never from inside the materialized tree, whose
entire content is untrusted bundle bytes.

A second signal force-kills owned processes and exits immediately, so it can
skip the terminal `cycle_end` record.
During preflight, a second signal after cycle-directory creation can also leave
an orphaned `cycles/<id>` directory; the next verify sweep covers only `verify/`.

## The receipt

`cycle result <cycle-id> --json` returns the usual `cycle-result/v1` document
with these additive fields (see [cycle-result-v1.md](./cycle-result-v1.md) §8):

- `identity.patchDigest` is the bound digest; `identity.patchDigestAlgorithm` is
  `gs-patch-digest/v1`; `identity.checkoutPath`, `branch` and `baseRevision` come
  from the request, `endRevision` equals the base.
- `evidence.bundlePath` points at `digest-input.bin` in the cycle directory: the
  frozen `D ++ U` bytes. The reader recomputes the digest from that file, so an
  edited file reads `stale_uncertain`. `evidence.diffPatchPath` is a separate,
  human-readable patch (untracked files shown as added files, secrets redacted).
- `verify` carries `mode` (`"verify_only"`), `changesetDigest`, `digestAlgorithm`,
  `baseRevision`, `checkoutPath`, `worktreePath`, `excludedPaths`,
  `verificationTreeId`, `excludesFilePath` (path or `"none"`),
  `excludesFileSha256` (hash or empty) for caller-pinned calls; otherwise legacy
  `globalExcludesFile` and `globalExcludesSha256` (the user's effective global
  git excludes file this check pinned on every change-set git call, and the
  SHA-256 of its bytes — both `null` when the user has none),
  `handsOffHits`, `cliVersion`, `reviewerProvider`, `failureCategory`, and
  `reaped` (whether every verification process group was proven reaped), and
  `cleanupFailed` (added by the receipt reader when the cycle's log has a
  `verify_cleanup_failed` event; the check's worktree could not be removed).

`verify.failureCategory` is `null` for a pass, else one of
`verification_nonzero`, `verification_timeout`, `verification_error`,
`reviewer_rejected`, `reviewer_error`, `reviewer_timeout`, `interrupted`,
`overall_timeout`, `internal_error`. `outcome.reason` is human-readable text,
not an exhaustive enum. It includes verification and stage failures (nonzero
exit, timeout, spawn error or an unproven process-tree reap), reviewer reasons
and reviewer failures (timeout, error or an unparseable response), interruption,
overall-budget expiry, and internal errors. Examples include
`Verification gate failed (exit N)`, `Verification timed out (time budget Ns)`,
`Reviewer response could not be parsed`, `Check interrupted (SIGTERM)`,
`Check exceeded its overall time budget (Ns)`, and
`Verification command's process tree was not proven reaped`.

A receipt with no `verify` object, or with another `mode`, is not a
verification of a change-set; a consumer must not treat it as one.
