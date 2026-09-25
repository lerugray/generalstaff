# Cycle result contract v1

Frozen machine-readable contract for one GeneralStaff CLI cycle result.
Desktop (and other callers) bind to this document — never to vendor prose or
local inference of a pass.

**Schema id:** `cycle-result/v1`  
**JSON Schema:** [`cycle-result-v1.schema.json`](./cycle-result-v1.schema.json)  
**Emitter:** `generalstaff cycle result <cycle-id> --json`  
**Authority:** CLI on-disk records only (`PROGRESS.jsonl`, cycle evidence dir,
`projects.yaml` for live checkout path). This contract does **not** change how
cycles run.

## 1. Invoking a cycle

| Item | Value today |
| --- | --- |
| Argv (single cycle) | `generalstaff cycle --project=<id> [--dry-run]` |
| Argv (session) | `generalstaff session` (and related session flags) — multiple cycles |
| Cwd | GeneralStaff root (directory that holds `projects.yaml` / state) |
| Exit codes | Process exits `0` after a completed single cycle regardless of `final_outcome` (outcome lives in the audit log). Missing `--project` / unknown project → `1`. |
| Stdout during run | Human progress lines (unbounded conversational). **Not** the v1 result document. |
| Result readback | `generalstaff cycle result <cycle-id> --json` → **one** v1 JSON object on stdout, pretty-printed; stderr for errors. Exit `0` on emit; `1` if cycle not found or unreadable. |

Bounded result stdout is the `cycle result --json` path only. Do not parse the
human cycle runner log for gate state.

`generalstaff cycle show <cycle-id> [--json]` remains the older dispatch-detail
view (gs-264). Its JSON shape is **not** this contract.

## 2. Document fields

| Field | Meaning | Source in CLI today |
| --- | --- | --- |
| `schemaVersion` | Always `"cycle-result/v1"` for this document | Emitter constant (not stored on cycle_end) |
| `cycleId` | Stable cycle id | `PROGRESS.jsonl` `cycle_id` / `CycleResult.cycle_id` (`YYYYMMDDHHMMSS_xxxx`) |
| `state` | Gate projection (see §3) | Derived from recorded events + evidence |
| `identity.projectId` | Registered project id | `project_id` on progress events / `CycleResult` |
| `identity.checkoutPath` | Absolute path of the project checkout | Live `projects.yaml` `path` at read time (**gap G1**) |
| `identity.branch` | Effective bot branch for the cycle | `cycle_start` / `diff_summary` `branch` |
| `identity.baseRevision` | SHA at cycle start | `cycle_start`/`cycle_end` `start_sha` / `CycleResult.cycle_start_sha` |
| `identity.endRevision` | SHA at cycle end (post-rollback if failed) | `cycle_end` `end_sha` / `CycleResult.cycle_end_sha` |
| `identity.patchDigest` | `sha256:` + hex of UTF-8 bytes of `diff.patch` | Computed at read from `state/<projectId>/cycles/<cycleId>/diff.patch` (**gap G2**: not written on `cycle_end`) |
| `outcome.finalOutcome` | `verified` \| `verified_weak` \| `verification_failed` \| `cycle_skipped` | `cycle_end.data.outcome` / `CycleResult.final_outcome` |
| `outcome.verificationOutcome` | `passed` \| `failed` \| `weak` | `cycle_end.data.verification_outcome` |
| `outcome.reviewerVerdict` | `verified` \| `verified_weak` \| `verification_failed` | `cycle_end.data.reviewer_verdict` / `reviewer_verdict` event |
| `outcome.reason` | Human reason string | `cycle_end.data.reason` |
| `receipts.verification` | Independent verification receipt | Derived from `verification_outcome` event (+ cycle_end fields). `id` = `{cycleId}:verification` (**gap G3**: no separate receipt UUID on disk) |
| `receipts.reviewer` | Independent reviewer receipt | Derived from `reviewer_verdict` event. `id` = `{cycleId}:reviewer` (**gap G3**) |
| `evidence.progressPath` | Relative path to the project progress log | `state/<projectId>/PROGRESS.jsonl` |
| `evidence.cycleDir` | Relative cycle evidence directory | `state/<projectId>/cycles/<cycleId>/` |
| `evidence.diffPatchPath` | Relative path to redacted diff | `…/diff.patch` when present |
| `evidence.reviewerResponsePath` | Relative path to reviewer response artifact | `…/reviewer-response.txt` when present |
| `timestamps.startedAt` / `endedAt` | ISO-8601 | First `cycle_start` timestamp; `cycle_end` timestamp (null if still running) |
| `gaps` | Versioned gap codes present on this emit | Emitter |

## 3. Gate `state` mapping (desktop §5)

| `state` | When the emitter sets it |
| --- | --- |
| `passed` | Terminal `cycle_end` with pass condition (§4) satisfied for this document’s `patchDigest` |
| `failed` | Terminal `cycle_end` whose outcome is not a pass (`verification_failed` or non-pass `cycle_skipped` with verification/review failure fields), or pass condition fails because required receipts are missing |
| `running` | `cycle_start` (or later non-terminal events) present and **no** `cycle_end` / `cycle_skipped` yet |
| `not_submitted` | Not emitted for a real `cycleId`. Desktop uses this when **no** cycle is bound to an order; the CLI has no such row |
| `unavailable` | Conflicting duplicate terminal records for one `cycleId`; unreadable/malformed required fields; or caller/schema mismatch handled by the desktop parser |
| `stale_uncertain` | Reserved for callers that detect a **changed patch** after a prior pass (digest mismatch vs currently bound candidate). The CLI emitter does not invent this alone from a single cycle record |

Desktop must never show `passed` unless §4 holds **and** the bound candidate’s patch digest equals `identity.patchDigest`.

## 4. Pass condition

`state` may be `passed` only when **all** of the following hold:

1. Exactly one terminal `cycle_end` event for `cycleId` (two terminals → `unavailable`).
2. `outcome.finalOutcome` ∈ {`verified`, `verified_weak`}.
3. `outcome.verificationOutcome` ∈ {`passed`, `weak`}.
4. `outcome.reviewerVerdict` ∈ {`verified`, `verified_weak`}.
5. `receipts.verification.present === true` and `receipts.reviewer.present === true`.
6. `identity.patchDigest` is a non-empty `sha256:` hex digest of the cycle’s `diff.patch` (empty patch still hashes; missing file → not passed).

`verified_weak` / verification `weak` count as pass for the gate (same convention as `src/results.ts`).

## 5. Conflict rules

1. **Changed patch invalidates a pass.** If the desktop’s current candidate patch digest ≠ `identity.patchDigest` for a previously `passed` document, treat gate as `stale_uncertain` (not `passed`). Require a new cycle.
2. **Two terminal records for one cycle.** If more than one `cycle_end` (or both `cycle_end` and `cycle_skipped`) exist for the same `cycleId` in the union of progress logs, emit `state: unavailable` with reason `duplicate_terminal_records`.

## 6. Versioned gaps

| Code | Gap |
| --- | --- |
| `G1` | Checkout path is read from live `projects.yaml`, not frozen into `cycle_end`. Path moves after the cycle are not detected by the CLI alone. |
| `G2` | `patchDigest` is not persisted on `cycle_end`; computed at read from `diff.patch`. If the file is rewritten after the cycle, the digest drifts (desktop should treat as stale). |
| `G3` | No durable independent receipt UUIDs; v1 uses synthetic `{cycleId}:verification` / `{cycleId}:reviewer`. |
| `G4` | `not_submitted` is a desktop binder state only; CLI never emits it for a looked-up cycle id. |
| `G5` | Cycle runner stdout is not machine-bounded; only `cycle result --json` is the contract stream. |

## 7. Fixtures

Versioned JSON under `tests/fixtures/cycle-result-v1/`: `passed`, `failed`, `unavailable`, `mismatched-patch`, `stale-uncertain`. Each validates against the schema in tests.
