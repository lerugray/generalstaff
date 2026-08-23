# Claim-battery release lane report

## Outcome

Implemented optional `claim_battery_command` as the third verification stage,
mirroring `player_path_command`, plus convention doc, README bullet, release
notes draft, CHANGELOG, and package version bump to 0.12.0. No commit or push.

## Files touched

- `src/types.ts` — `claim_battery_command?: string`; progress events
  `claim_battery_run` / `claim_battery_outcome` in type union + allowlist.
- `src/projects.ts` — parse + aggregate validation (string required if set;
  empty rejected; type errors aggregate); assigned onto ProjectConfig.
- `src/verification.ts` — `shouldRunClaimBattery`, `CLAIM_BATTERY_TIMEOUT_MS`,
  `runClaimBattery`; dry-run + live path after player_path, before smoke;
  ordering comments updated.
- `tests/types.test.ts` — new event names in expected list.
- `tests/verification.test.ts` — `describe("claim_battery_command")` cases
  (pass/order, fail, skip on unit fail, skip on player_path fail, dry-run,
  audit events, full four-stage order).
- `tests/projects.test.ts` — unset/load/reject-non-string/reject-empty/
  aggregate validation.
- `docs/conventions/claim-battery.md` — anonymized methodology (all eight
  mechanics), ordering, worked example, claims-manifest shape, GS wiring.
- `docs/conventions/player-path-verification.md` — ordering line updated to
  include claim battery (doc-drift fix).
- `docs/internal/release-notes-v0.12.0-DRAFT.md` — DRAFT release notes.
- `README.md` — config bullet next to player_path.
- `projects.yaml.example` — commented `claim_battery_command` + ceremony step.
- `CHANGELOG.md` — `## [0.12.0] — 2026-08-10`.
- `package.json` — `"version": "0.12.0"`.
- `LANE-REPORT-claim-battery.md` — this report.

## Verification

- Focused: `bun test tests/verification.test.ts tests/projects.test.ts
  tests/types.test.ts` — **181 passing, 0 failing**.
- Full suite: `bun test` — **2,226 passing + 4 skipped across 2,230 tests,
  0 failing** (10,629 assertions across 80 files).
- Privacy scan on claim-battery convention + release draft: no BA / David /
  Sqn-29 / WHATS-NEW-as-product / kit / person-name hits.

## Omissions

None relative to the brief. No commit or push was made. Working tree left
dirty for orchestrator review.
