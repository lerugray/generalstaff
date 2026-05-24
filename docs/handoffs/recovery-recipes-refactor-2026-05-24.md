# GS recovery_recipes refactor — handoff brief 2026-05-24

Pattern lifted from the Claw Code architecture deep-study Hammerstein-7b
produced 2026-05-24 (`homelab/docs/research/2026-05-24-0702-greetings-
hammerstein-i-want-you.md`). The relevant module there is
`rust/crates/runtime`'s `recovery_recipes`: named `FailureScenario` types
map to ordered `RecoveryRecipe` step tables, with an `EscalationPolicy`
when all steps fail and a `RecoveryLedgerEntry` recording what happened.

## Why GS is a candidate

GS's error handling is currently ad-hoc try/catch + `console.error`
scattered across the source tree. The Hammerstein research surfaced
this as a high-leverage applicable pattern; the verification pass
2026-05-24 found a bigger scope than the initial mapping implied,
which is why this is a brief, not a one-shot dispatch.

## Measured scope (2026-05-24, master commit five-ahead-of-origin)

Total `catch` blocks across `src/**.ts`: **418**.

Density by file (top 10):

| File | Catch count | Role |
|---|---|---|
| `src/cli.ts` | 43 | CLI command surface |
| `src/cycle.ts` | 21 | bot cycle execution loop |
| `src/doctor.ts` | 18 | doctor diagnostics |
| `src/session.ts` | 14 | session orchestration |
| `src/summary.ts` | 10 | session summary generation |
| `src/heartbeat/supervisor.ts` | 8 | heartbeat dispatch |
| `src/reviewer.ts` | 7 | verification reviewer |
| `src/benchmark.ts` | 7 | benchmark harness |
| `src/welcome.ts` | 6 | welcome flow |
| `src/views/dispatch_detail.ts` | 6 | dispatch detail view |
| `src/safety.ts` | 6 | safety enforcement |
| `src/phase.ts` | 6 | phase tracking |

Note: the Sonnet subagent's initial mapping pointed at
`src/dispatcher.ts` (1 catch — not the right target). The actual
high-leverage target is `src/cycle.ts` where the 21 catches sit in the
bot's real per-cycle execution path. That's where retry-with-backoff,
fallback-to-different-provider, and known-recoverable-error patterns
already exist informally.

## Recommended shape: thin slice first

Cycle.ts has the right density + the right semantics — a cycle either
completes, fails recoverably (retry), or fails terminally (escalate).
That maps cleanly to the Claw Code shape.

**Phase 1 — thin slice on `src/cycle.ts` only:**

1. Define a `FailureScenario` discriminated union covering the failure
   modes the current cycle.ts catches actually handle (read each catch,
   classify it — don't invent scenarios).
2. Create `src/recovery/` directory with:
   - `recovery_recipes.ts` — the `Recipe`, `Step`, `EscalationPolicy`
     types + the scenario→recipe map.
   - `recovery_ledger.ts` — append-only JSONL log of recipe executions
     and outcomes; lands alongside the existing `log/git-ops.jsonl`
     pattern from homelab/bot.
   - `index.ts` — public surface.
3. Replace each `catch` in cycle.ts with a `try { ... } catch (e) {
   await executeRecipe(classifyError(e, ctx)) }` pattern.
4. Keep the existing behavior IDENTICAL for each scenario in this
   phase — the refactor is structural, not behavioral. Any
   behavior-change recipe (different retry count, different fallback)
   is a follow-up commit, not part of the structural pass.

**Phase 2 (only if Phase 1 lands clean):**

Sweep `src/cli.ts` (43 catches) and `src/doctor.ts` (18 catches). Both
are user-facing — the recipe ledger output becomes part of the error
UX, which is where this pattern earns its real keep.

**Phase 3 (future):**

Per-engineer-provider failure scenarios in `src/engineer.ts` +
`src/engineer_providers/*`. Different providers (claude, aider, cursor)
have different failure shapes; scenarios should encode that.

## Anti-scope (intentional)

- Don't sweep ALL 418 catches in one pass. Plenty of them are
  defensive-around-IO and don't have meaningful recovery semantics —
  forcing them into a recipe shape adds friction without value.
- Don't change the cycle's actual retry counts, timeout values, or
  escalation triggers in the structural pass. Behavior preservation
  is the gate for "did we refactor or did we accidentally change
  things."
- Don't add telemetry-surface fields beyond what the existing audit
  log already carries (the homelab/bot pattern is the reference). New
  telemetry is its own decision.

## Open questions (for the next session to surface to Ray)

1. **Scope confirmation**: thin-slice cycle.ts only, OR cycle.ts +
   one of cli.ts / doctor.ts? Lean: cycle.ts only first.
2. **Recipe definition style**: discriminated union of typed scenarios
   (compile-time exhaustive) vs string-keyed map (runtime flexible).
   Lean: discriminated union — TypeScript catches missing scenarios
   at compile time, which matches GS's other patterns.
3. **Ledger location**: `log/recovery.jsonl` next to `log/git-ops.jsonl`
   (per-machine, gitignored) vs a structured top-level state file.
   Lean: `log/recovery.jsonl` — matches the existing append-only
   audit-log discipline.
4. **Hands_off check**: this lands in `src/` which is on the GS
   hands_off list per `projects.yaml` policy. The next session is
   `interactive_only`, not bot-pickable. Confirm before code drops.

## Pre-flight before starting Phase 1

1. Read `homelab/docs/research/2026-05-24-0702-greetings-hammerstein-
   i-want-you.md` §3 (recovery_recipes module) in full — this brief
   is a summary; that file is the source.
2. Read `src/cycle.ts` end to end. The 21 catches are not uniform;
   classification matters.
3. Read 2-3 of the existing catches in cycle.ts AS THEY ARE TODAY
   and write down what they actually do. The structural pass must
   preserve that behavior.
4. Surface the four open questions above to Ray before writing code.
5. The thin-slice phase should fit in one session if scoped tightly.
   If it's looking bigger after pre-flight, narrow scope further
   (cycle.ts's 5 most-load-bearing catches only) rather than
   stretching the session.

## Status as of 2026-05-24

- GS master is 5 commits ahead of origin/master (unpushed; blocked
  on workflow-scope PAT). Not relevant to this work but worth
  noting — push from a machine with workflow scope when convenient.
- No code for this refactor has landed. This brief is the starting
  point.
- Related shipped work from the same Hammerstein-research
  application sweep: (1) homelab/bot codegen pre-flight request-size
  check at `1dbe2c4` on homelab master; (2) Tauri code-signing
  identity wired across GSD / mission-companion / devforge so macOS
  TCC stops re-prompting.
