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
| `--overall-timeout=<s>` | Budget for the whole check after it starts. Default 900. |
| `--grace=<s>` | Wait between the polite stop signal and the force kill. Default 10. |

There is no model, provider or runner flag. The reviewer is chosen by the
project's configuration and the user's own `GENERALSTAFF_REVIEWER_*`
variables, exactly as for an autonomous cycle. The receipt records the provider
that actually ran.

The overall budget is the hard limit. A caller that supervises the process
should give it strictly more than `overall + grace` so the check can always
write its own terminal record.

### Exit codes

| Code | Meaning | Receipt |
| --- | --- | --- |
| 0 | The check ran and passed (`verified` or `verified_weak`) | yes |
| 1 | The check ran and did not pass | yes |
| 2 | Usage error: a missing, malformed or unknown flag | no |
| 3 | Preflight refusal (below) | no |
| 4 | Internal error before a receipt could be written | no |
| 128+N | Interrupted by signal N; a terminal record was written | yes |

### `--json` output

Exactly one line on stdout; everything else goes to stderr.

Started (written as soon as the cycle is recorded):

```json
{"schemaVersion":"cycle-verify/v1","cycleId":"20260929155314_nt3x","projectId":"app","state":"running","mode":"verify_only"}
```

Refused (exit 2 or 3; nothing was recorded):

```json
{"schemaVersion":"cycle-verify/v1","refused":true,"state":"refused","cycleId":null,"reason":"digest_mismatch","message":"..."}
```

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
| `empty_patch` | the change-set is empty |
| `no_verification_command` | the project has no verification command |
| `verify_in_progress` | another check is running for this project |
| `materialize_failed` | the isolated worktree could not be built or the patch did not apply |
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
6. Writes one `cycle_end` (on every path: pass, fail, timeout, signal, internal
   error), then removes the worktree.

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

The verification command runs in its own process group (a `taskkill /T` tree on
Windows). On a timeout, a signal or the overall budget the group receives a
polite stop, then a force kill after the grace period. After every command the
group is swept, so background processes the command left running do not survive.
The command's environment is a small pinned set (`PATH`, `HOME`, locale,
temp-dir variables, `GENERALSTAFF_VERIFY_ONLY=1`, `GENERALSTAFF_CYCLE_ID`);
other variables of the calling process, including reviewer credentials, are not
passed unless named in `GENERALSTAFF_VERIFY_ENV_PASSTHROUGH` (comma separated).
The reviewer process keeps the calling environment, as always.

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
  `baseRevision`, `checkoutPath`, `worktreePath`, `excludedPaths`, `handsOffHits`,
  `cliVersion`, `reviewerProvider` and `failureCategory`.

`verify.failureCategory` is `null` for a pass, else one of
`verification_nonzero`, `verification_timeout`, `verification_error`,
`reviewer_rejected`, `reviewer_error`, `reviewer_timeout`, `interrupted`,
`overall_timeout`, `internal_error`. `outcome.reason` reads
`Verification gate failed (exit N)`, `Verification timed out (time budget Ns)`,
the reviewer's own reason, `Check interrupted (SIGTERM)`, or
`Check exceeded its overall time budget (Ns)`.

A receipt with no `verify` object, or with another `mode`, is not a
verification of a change-set; a consumer must not treat it as one.
