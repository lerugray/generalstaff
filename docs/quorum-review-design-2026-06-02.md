# Multi-reviewer quorum review — design proposal

**Status:** Implemented, 2026-06-02. Additive + opt-in; default single-reviewer
behavior is unchanged (absent `review` or a single-entry `reviewers` list ==
today's path). Synthesis contract: `synthesizeQuorum` in `src/reviewer.ts`;
orchestrator `runQuorumReview`; config type `ReviewConfig` in `src/types.ts`
(validated in `src/projects.ts`); one call-site swap in `src/cycle.ts`. Tests:
`tests/quorum.test.ts` (honest-error + union-by-agreement + aggregate-verdict) +
`review` validation cases in `tests/projects.test.ts`. The v2 reviewer-track-
record layer below is still future work.
**Scope:** GeneralStaff core review step (`reviewer_provider`).

## Motivation

Today a cycle's diff is judged by a single `reviewer_provider` (claude default,
openrouter fallback on error). Its verdict (`verified` / `verified_weak` /
`verification_failed`) gates the merge. For an operator who does not read diffs
line-by-line, that single reviewer is a single point of trust on every auto-merge.
A quorum of independent reviewers raises confidence and surfaces disagreement
honestly, at the cost of N× reviewer spend — so it is opt-in, not default.

## Pattern

A multi-voice consensus pattern with three load-bearing properties:

1. **Parallel independence** — each reviewer judges the same diff without seeing
   the others, so the verdicts are genuinely diverse, not an echo.
2. **Reconciliation (synthesis, not pick-best)** — findings are merged into one
   list, not presented as N side-by-side reviews. Pick-best is rejected: it would
   discard the diversity that is the entire point (reviewer B's real catch lost
   because reviewer A scored "better overall"). Different reviewers catch
   different real bugs; the union is what matters.
3. **Honest-error + quorum contract** — a reviewer that fails is *dropped, never
   fabricated*, and synthesis requires a minimum number of *real* reviews to be
   called a quorum (else it transparently falls back to single-reviewer and says
   so). This is the property that makes the merged verdict trustworthy.

## Mechanism

1. **Config** (per project, `projects.yaml`): a `reviewers` list. One entry →
   today's single-reviewer behavior (backward compatible). More than one →
   quorum mode.
2. Each reviewer judges the diff **independently, in parallel** → `{verdict,
   findings[]}`.
3. **Merge:** union the findings, dedup, and **tag each by agreement count**
   (how many reviewers raised it). 3/3 = high-confidence real; 1/3 = surface as
   uncertain. Agreement *is* the confidence signal.
4. **Aggregate verdict** by `quorum_policy`:
   - `conservative` (recommended when `auto_merge: true`): any blocking finding
     from any reviewer holds the merge for human review; auto-merge only if all
     reviewers are ≥ `verified_weak` with no blockers. Safest when no human reads
     the diff.
   - `majority` (for `auto_merge: false`, i.e. a `bot/work` branch awaiting an
     operator relay): merge if the majority verdict is `verified`; the split is
     surfaced in the relay.
5. **Output:** a merged, plain-English review plus a confidence signal (agreement
   level) — the artifact the operator actually reads instead of the diff. This is
   what de-risks an auto-merge the operator cannot inspect directly.

## Honest-error + quorum contract (load-bearing)

- A reviewer that errors/times out is dropped from the synthesis, **never
  fabricated**.
- Synthesis requires `min_real_reviews` (default 2) real reviews to be treated as
  a quorum. Below that, it falls back to single-reviewer and labels the result as
  such — it does not present one survivor's verdict as if it were vetted by many.

## Cost (Hard Rule 8 — operator pays per reviewer)

- **Opt-in per high-stakes project**; default stays single-reviewer.
- **Mix tiers** for diversity without budget blowup — e.g. one cheap reviewer
  (OpenRouter Qwen / DeepSeek), one strong (Claude), and a **free local
  framework-discipline voice** (a small local model). The cheap/free voices won't
  catch line-level bugs but the local framework voice catches plan-level
  "stupid-industrious" diffs at ~$0.

## Config sketch (additive to `projects.yaml`)

```yaml
review:
  reviewers:
    - { provider: claude,     model: <...> }
    - { provider: openrouter, model: <qwen-coder-...> }
    - { provider: <local>,    model: <framework-voice> }   # free plan-level voice
  quorum_policy: conservative   # conservative | majority
  min_real_reviews: 2
# absent `reviewers` (or a single entry) => current single-reviewer behavior
```

## v2 — reviewer track-record (calibration)

Log each reviewer's verdict against the eventual outcome (merge survived /
reverted / spawned a follow-up fix). Over many cycles, build a per-reviewer
reputation and weight or down-rank accordingly. This is the "which reviewer does
the best job" mechanism — a calibration layer, shipped *after* synthesis so it has
real outcomes to learn from.

## Non-goals

- Not default-on (cost).
- Not pick-best-reviewer (discards the diversity that is the point — synthesis
  unions findings instead).
