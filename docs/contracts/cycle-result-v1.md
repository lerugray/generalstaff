# Cycle result contract v1

Frozen machine-readable contract for one GeneralStaff CLI cycle result.
Desktop (and other callers) bind to this document — never to vendor prose or
local inference of a pass.

**Schema id:** `cycle-result/v1`  
**JSON Schema:** [`cycle-result-v1.schema.json`](./cycle-result-v1.schema.json)  
**Emitter:** `generalstaff cycle result <cycle-id> --json`  
**Authority:** CLI on-disk records only (`PROGRESS.jsonl`, cycle evidence dir,
`projects.yaml` for live checkout path when not frozen). This contract does
**not** change how cycles run.

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
| `identity.checkoutPath` | Absolute path of the project checkout | Prefer `cycle_end.data.checkout_path` (frozen after **2026-09-25**). Else live `projects.yaml` `path` |
| `identity.branch` | Effective bot branch for the cycle | Prefer `cycle_end.data.branch`; else `cycle_start` / `diff_summary` `branch` |
| `identity.baseRevision` | SHA at cycle start | Prefer `cycle_end.data.base_revision`; else `start_sha` / `CycleResult.cycle_start_sha` |
| `identity.endRevision` | SHA at cycle end (post-rollback if failed) | `cycle_end` `end_sha` / `CycleResult.cycle_end_sha` |
| `identity.patchDigest` | `sha256:` + 64 lowercase hex of UTF-8 bytes of `diff.patch` **as read now** | File bytes at emit time. Pass requires `cycle_end.data.patch_digest` equal that digest (frozen after **2026-09-25**) |
| `outcome.finalOutcome` | `verified` \| `verified_weak` \| `verification_failed` \| `cycle_skipped` | `cycle_end.data.outcome` / `CycleResult.final_outcome` |
| `outcome.verificationOutcome` | `passed` \| `failed` \| `weak` | Dedicated `verification_outcome` event (preferred); may be mirrored on `cycle_end` for display only |
| `outcome.reviewerVerdict` | `verified` \| `verified_weak` \| `verification_failed` | Dedicated `reviewer_verdict` event (preferred); may be mirrored on `cycle_end` for display only |
| `outcome.reason` | Human reason string | `cycle_end.data.reason` |
| `receipts.verification` | Independent verification receipt | **`present: true` only from a dedicated `verification_outcome` / `verification_end` event** — never from `cycle_end` alone. `id` = `{cycleId}:verification` (**gap G3**: no separate receipt UUID on disk) |
| `receipts.reviewer` | Independent reviewer receipt | **`present: true` only from a dedicated `reviewer_verdict` / `reviewer_end` event** — never from `cycle_end` alone. `id` = `{cycleId}:reviewer` (**gap G3**) |
| `evidence.progressPath` | Relative path to the project progress log | `state/<projectId>/PROGRESS.jsonl` |
| `evidence.cycleDir` | Relative cycle evidence directory | `state/<projectId>/cycles/<cycleId>/` |
| `evidence.diffPatchPath` | Relative path to redacted diff | `…/diff.patch` when present |
| `evidence.reviewerResponsePath` | Relative path to reviewer response artifact | `…/reviewer-response.txt` when present |
| `timestamps.startedAt` / `endedAt` | ISO-8601 | First `cycle_start` timestamp; `cycle_end` timestamp (null if still running) |
| `gaps` | Versioned gap codes present on this emit | Emitter (omit closed gaps when frozen fields exist) |

### Additive `cycle_end` fields (recorded after 2026-09-25)

| Field on `cycle_end.data` | Meaning |
| --- | --- |
| `patch_digest` | `sha256:` + 64 hex of `diff.patch` bytes **as written** |
| `checkout_path` | Absolute project checkout path at cycle end |
| `branch` | Effective bot branch |
| `base_revision` | Cycle start SHA (same value as `start_sha`) |

Existing readers ignore unknown fields. Cycles recorded before this change omit them.

## 3. Gate `state` mapping (desktop §5)

| `state` | When the emitter sets it |
| --- | --- |
| `passed` | Exactly one terminal; §4 pass condition; recorded `patch_digest` present and equals current `diff.patch` digest; identity + evidence complete |
| `failed` | Terminal whose outcome is not a pass, or required dedicated receipts are absent |
| `running` | `cycle_start` (or later non-terminal events) present and **no** `cycle_end` / `cycle_skipped` yet |
| `not_submitted` | Not emitted for a real `cycleId`. Desktop uses this when **no** cycle is bound to an order; the CLI has no such row |
| `unavailable` | Two or more terminal records of any kind (including multiple `cycle_skipped`); missing identity/evidence when a pass would otherwise be claimed; malformed recorded digest |
| `stale_uncertain` | Recorded `patch_digest` missing (pre-freeze cycle) or ≠ digest of `diff.patch` read now, when the cycle would otherwise look like a pass |

Desktop must never show `passed` unless §4 holds **and** the bound candidate’s identity (project, cycle, checkout, branch, base revision, patch digest) equals the document.

## 4. Pass condition

`state` may be `passed` only when **all** of the following hold:

1. Exactly one terminal record for `cycleId` (any mix of two+ `cycle_end` / `cycle_skipped` → `unavailable`).
2. `outcome.finalOutcome` ∈ {`verified`, `verified_weak`}.
3. `outcome.verificationOutcome` ∈ {`passed`, `weak`}, from a **dedicated** verification event (`receipts.verification.present === true`).
4. `outcome.reviewerVerdict` ∈ {`verified`, `verified_weak`}, from a **dedicated** reviewer event (`receipts.reviewer.present === true`).
5. Receipt ids equal `{cycleId}:verification` and `{cycleId}:reviewer`.
6. `identity.checkoutPath`, `identity.branch`, and `identity.baseRevision` are non-null.
7. `identity.patchDigest` matches `^sha256:[0-9a-f]{64}$` and equals `cycle_end.data.patch_digest` (recorded) **and** the digest of `diff.patch` bytes read now.
8. All `evidence.*` paths are non-null.

`verified_weak` / verification `weak` count as pass for the gate (same convention as `src/results.ts`).

A cycle recorded **before** 2026-09-25 with no `patch_digest` on `cycle_end` never emits `passed` (→ `stale_uncertain` when outcomes otherwise look like a pass).

## 5. Conflict rules

1. **Changed patch invalidates a pass.** If `cycle_end.data.patch_digest` ≠ digest of current `diff.patch`, emit `stale_uncertain` (not `passed`). Desktop also rejects when its bound candidate digest ≠ `identity.patchDigest`.
2. **Two or more terminal records for one cycle.** If more than one terminal (`cycle_end` and/or `cycle_skipped`, including two skips) exist for the same `cycleId`, emit `state: unavailable` with reason `duplicate_terminal_records`.

## 6. Versioned gaps

| Code | Status | Gap |
| --- | --- | --- |
| `G1` | **Closed** for cycles recorded after **2026-09-25** (`checkout_path` on `cycle_end`). Still listed when that field is absent (older cycles / live `projects.yaml` fallback). | Checkout path was previously read only from live `projects.yaml`. |
| `G2` | **Closed** for cycles recorded after **2026-09-25** (`patch_digest` on `cycle_end`). Older cycles without a recorded digest never `passed` (`stale_uncertain`). | Patch digest was previously computed only at read from `diff.patch`. |
| `G3` | **Open** | No durable independent receipt UUIDs; v1 uses synthetic `{cycleId}:verification` / `{cycleId}:reviewer`. |
| `G4` | Open (desktop-only) | `not_submitted` is a desktop binder state only; CLI never emits it for a looked-up cycle id. |
| `G5` | Open | Cycle runner stdout is not machine-bounded; only `cycle result --json` is the contract stream. |

## 7. Fixtures

Versioned JSON under `tests/fixtures/cycle-result-v1/`: `passed`, `failed`, `unavailable`, `mismatched-patch`, `stale-uncertain`. Each validates against the schema in tests. The `passed` fixture represents a post-2026-09-25 cycle (`gaps` omit G1/G2).
