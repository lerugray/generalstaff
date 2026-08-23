# LANE-REPORT — docs/hygiene (wt-docs)

**Branch:** `wt-docs`  
**Date:** 2026-08-23  
**Scope:** COMPATIBILITY.md + workshop-residue move + one README link

## Files created / moved

| Action | Path |
| --- | --- |
| **Created** | `docs/COMPATIBILITY.md` |
| **Moved** | `LANE-REPORT-claim-battery.md` → `docs/internal/LANE-REPORT-claim-battery.md` |
| **Moved** | `LANE-REPORT-player-path.md` → `docs/internal/LANE-REPORT-player-path.md` |
| **Edited** | `README.md` — exactly one new link line (Observability, after local dashboard) |
| **Created** | `LANE-REPORT-docs.md` (this report) |

Move note: renames are present on HEAD as of `f6e117d` (`R100` both reports into `docs/internal/`). Working tree confirmed only under `docs/internal/`; root copies gone.

## References updated

Grep for `LANE-REPORT-claim-battery` and `LANE-REPORT-player-path` across the repo:

- **No external links** to update.
- Only hits: self-references inside each report (`— this report.`), filename-only — left as-is.

## UNRESOLVED mode-guarantee rows

Autonomous mode — **May be pushed** and (for remote `bot/work`) **Never pushed**:

README both (a) says mechanical work is “dispatched through the normal cycle” / Hard Rule 7 “Bot pushes to `bot/work` on your remote only,” and (b) says autonomous “never auto-pushes” / “never pushes or merges.” DESIGN only states “Never push to master directly.” Merge-to-default-branch stays human is agreed; whether autonomous `--execute` may still push `bot/work` to origin is **UNRESOLVED** (quoted in `docs/COMPATIBILITY.md`).

Manually queued rows: resolved from README + DESIGN (may push `bot/work`; never push master directly; `PROGRESS.jsonl` audit).

## Other root residue (candidates — not moved)

Per instructions, listed only:

- `LANE-REPORT-infra.md`
- `LANE-REPORT-secfix.md`

(Same workshop-report pattern; left at root.)

## Version line

CLI **0.12.0** from `package.json`. Desktop: “see Desktop repo.”

## Suite

```
bun install && bun test
2231 pass
4 skip
0 fail
Ran 2235 tests across 81 files.
```

## Commit / push

- Committing docs changes on `wt-docs`.
- **Not pushed** (per hard rule).
