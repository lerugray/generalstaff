# Phase 4 — Complete (2026-04-18)

**Closed:** 2026-04-18 afternoon
**Elapsed from Phase 3 close:** ~4 hours (2026-04-18 morning → afternoon, same day)
**Shape:** one continuous interactive Claude session (Opus 4.7, 1M context)

## Summary

Phase 4 per PIVOT-2026-04-15.md §"Phased build plan" =
**parallel worktrees across projects** — multiple managed
projects cycling simultaneously instead of sequentially. The
user-value proposition is multiplicative throughput: with 3
registered projects (generalstaff, gamr, raybrain) each
carrying real backlogs, a 60-min session that ran ~32 cycles
sequentially can now run ~96 cycles at `max_parallel_slots: 3`
with perfect slot utilization.

Parallel mode is **opt-in** via `dispatcher.max_parallel_slots`
in `projects.yaml` (default 1 preserves Phase 1-3 sequential
behaviour bit-for-bit). The choice reflects Hard Rule 8 (BYOK)
— turning parallelism on doubles or triples the user's reviewer
API spend in that session, and silently flipping it on upgrade
would surprise anyone paying per token.

The design was fully sketched in DESIGN.md §v6 on the morning
of 2026-04-18 with gstack+Conductor (YC Garry Tan's AI-assisted
engineering setup) cited as external precedent. The four phased
implementation steps the design called out — gs-185/186/187/188
— all shipped in the afternoon arc, with the work broken up to
keep each commit's diff small and each verification step clean.

## What shipped

### Tasks landed (Phase 4 afternoon: 2026-04-18 ~12:30 → ~16:30 local)

| Task | Commit | File(s) | Purpose |
|------|--------|---------|---------|
| gs-185 | 1b065f2 | `src/dispatcher.ts` | `pickNextProjects` returns up to N candidates; `pickNextProject` is a thin back-compat maxCount=1 shim |
| gs-186 | d3d457a | `src/session.ts`, `src/types.ts`, `src/projects.ts`, `projects.yaml.example` | Round-based parallel loop behind `dispatcher.max_parallel_slots > 1`; Promise.all over picks; chaining disabled in parallel mode; slot_idle tracking |
| gs-187 | dbbb7c2 | `src/reviewer.ts` | Per-provider `PromiseSemaphore` keyed on claude/openrouter/ollama; defaults ∞/2/1; env override `GENERALSTAFF_REVIEWER_CONCURRENCY_<PROVIDER>=N` |
| gs-188 | 43bfeec | `src/session.ts`, `src/sessions.ts` | `computeParallelEfficiency` + digest `**Parallel:**` line + sessions-table `Parallel` column when any session in window used parallel mode |

### Closure-tail shipped alongside Phase 4 (same arc)

Phase 3's remaining P1/P2 follow-ups also landed in this session,
so the closure-tail from TODAY-2026-04-18-CLOSURE.md is fully
shipped except the P3 interactive-only gs-184:

| Task | Commit | Purpose |
|------|--------|---------|
| gs-193 | 96e16dd | Fast-fail backoff — soft-skip projects after N=3 consecutive failures in M=600s. Prevents the 82-cycle retry-spin pattern observed on raybrain 2026-04-18 morning |
| gs-191 | ca7010d | Hot-reload projects.yaml between cycles — mid-session registrations visible without restart |
| gs-195 | ba6b11b | Queue-time hands_off gate — `expected_touches: string[]` and `interactive_only: true` optional fields on GreenfieldTask; `isTaskBotPickable` helper; picker skips tasks whose declared touches intersect hands_off |
| gs-190 | b5a9a39 | Python stack detection extended — pyproject.toml inspection for `[tool.uv]` / `[tool.poetry]`, lockfile heuristics, requirements.txt/setup.py/setup.cfg/.python-version fallbacks; `generalstaff register --stack=<kind>` wired |

All eight commits pushed to `master` on
`github.com/lerugray/generalstaff`. Working tree clean at doc-
write time; `bot/work` unmerged = 0; fleet state clean.

## Design decisions that got shipped

Three decisions were deferred to Ray at the start of the session.
He delegated them to philosophy (Hammerstein + local-first
principles), and they shipped as:

1. **When slots > eligible projects, leave slots idle** rather
   than fill with low-value work. Stupid-industrious quadrant
   if we fill for the sake of filling. The implementation falls
   out naturally: `pickNextProjects` returns fewer than
   `maxCount` when fewer are eligible, and the parallel loop
   just runs what came back.
2. **Default `max_parallel_slots: 1`.** Hard Rule 8 BYOK means
   users bear cost. Silent upgrade that doubles reviewer spend
   is a violation of the opt-in principle underpinning the
   pivot; anyone who wants parallelism sets the field
   explicitly in `projects.yaml`.
3. **Strict round-based wait first, measure, escalate if
   painful.** DESIGN.md §v6 Q3's explicit recommendation. The
   round blocks on `Promise.all` until the slowest slot
   finishes; idle slots wait for their sibling. `slot_idle_seconds`
   is now emitted in `session_complete` so the "is this painful
   enough to escalate to option (b)?" question has data behind
   it on the next Ingest pass.

## Parallel-mode instrumentation (gs-188)

`session_complete` events in the fleet PROGRESS.jsonl now carry:

```json
{
  "max_parallel_slots": 3,
  "parallel_rounds": 4,
  "slot_idle_seconds": 75,
  "parallel_efficiency": 0.823
}
```

when the session ran parallel mode. Sequential sessions continue
to emit the pre-gs-186 event shape (no parallel fields, no
divergence in the existing digest renderers).

`parallel_efficiency = 1 - slot_idle_seconds / (slots × elapsed_seconds)`
— clamped to [0, 1]. 1.0 = perfect utilization; 0 = every
slot-second was idle (degenerate, unreachable in normal operation).
Visible in three places:

1. **Digest header** — `**Parallel:** 3 slots, 4 round(s),
   1m15s slot-idle, 82.3% efficiency` when slots > 1, otherwise
   omitted entirely.
2. **`generalstaff status --sessions` table** — new `Parallel`
   column when any session in the window used parallel mode
   (otherwise hidden — no regression for single-slot users).
   Cell format: `3× @ 82%`; sequential rows in mixed tables
   show an em-dash so columns line up.
3. **`session_complete` event** — for anyone reading the raw
   audit log (status --json pipelines, notebook analysis).

## Tests

**Unit + subprocess-helper tests added across Phase 4:**

- `updateFailureStreak` (gs-193): 11 tests, covers the two
  retry-spin cases (1-sec crash loop + 5-min failure loop),
  window-edge cases (exact 10-min boundary), success-resets-
  streak, custom thresholds.
- `hotReloadProjects` (gs-191): 7 tests, add/remove/mixed/error
  paths + first-call-from-empty-cache + config-update
  propagation.
- `isTaskBotPickable` / `botPickableTasks` + work_detection
  integration (gs-195): 14 tests, covers the rayb-001-shape
  hands_off scope collision + interactive_only precedence +
  in_progress remains pickable (matches pendingTasks semantic).
- `classifyPyproject` / `installStepForStack` / new detectStack
  markers (gs-190): 24 tests, including a regression pin that
  `rust-cargo` install step does NOT emit `bun install` — the
  specific bug raybrain hit before the other Claude session
  hand-patched the template.
- `pickNextProjects` (gs-185): 9 tests, maxCount=0/1/N,
  fewer-than-requested, skip-set across slots, override-claims-
  first-slot-no-dup, empty / all-skipped.
- Parallel session runtime (gs-186): subprocess helper
  `verify_parallel_session.ts` asserts both projects cycle, the
  Promise.all siblings' wall-clock intervals overlap (real
  parallelism), `pickNextProjects` (not `pickNextProject`) is
  used, `session_complete` carries the parallel metrics.
- `reviewerConcurrencyLimit` / `withReviewerSemaphore` (gs-187):
  15 tests — defaults per provider, env override (numeric
  valid / invalid / zero+negative rejected), serialization at
  limit=1, peak-concurrency cap at limit=2, unbounded when
  claude, release-on-throw, per-provider isolation (openrouter
  burst doesn't block ollama).
- `computeParallelEfficiency` + digest rendering + sessions-
  table column (gs-188): 11 tests — edge math + back-compat
  for sequential-only tables.

Session-close totals: **1099 tests pass, 0 fail, tsc clean.**
Across the day (morning closure-tail + afternoon Phase 4):
+80 new tests, +~2800 lines of diff across ~25 files.

## Cost signal (observational)

This session was interactive-only — no bot cycles fired — so
external API spend is zero. The Claude Max subscription carried
the interactive work.

Phase 4 parallel mode, once a user opts in via
`max_parallel_slots: N`, multiplies reviewer-step API calls by
roughly N during that session. The gs-187 semaphore caps this
per provider (default 2 for OpenRouter free tier, 1 for local
Ollama, unbounded for Claude subscription auth which self-
limits upstream). Users who need more throughput and are on an
OpenRouter paid tier can raise via env:
`GENERALSTAFF_REVIEWER_CONCURRENCY_OPENROUTER=8`.

The gs-188 `slot_idle_seconds` metric will tell us whether this
is bottlenecked by reviewer-semaphore queueing (idle rises as
slots contend for the same provider) or by wall-clock cycle
duration variance (idle rises when one cycle runs far longer
than its siblings). The first case is solved by raising the
semaphore; the second is what DESIGN.md §v6 Q3's optional
"early-start" mode would address — preserve the choice for
observation first.

## What's next

**Pending queue after Phase 4:**

- **gs-184** (P3, interactive-only): picker tiebreak rule in
  `scripts/run_bot.sh` prompt. Low-value; workaround (demote
  priorities) is fine until same-priority collisions become
  routine.

**Phase 5 pointer (unchanged from pivot plan):** local desktop UI
viewer/controller layer. Kriegspiel-themed per
UI-VISION-2026-04-15.md. Phase 4 instrumentation from gs-188
(`parallel_efficiency`, per-slot idle) is exactly the kind of
data a good dashboard wants to surface — the read side is ready
for whatever visualization pass comes later.

**Measure-and-decide item (not a task yet):** after a few real
multi-project parallel sessions, review `slot_idle_seconds`
against `parallel_rounds × wall_clock`. If idle consistently
exceeds ~30% of total slot-seconds, DESIGN.md §v6 Q3's (b)
early-start scheduler becomes a real upgrade candidate. Until
then it's speculative.

## Why this matters

Phase 4 is the last scaling-oriented architecture Phase of the
pivot plan. Phases 5+ are user-experience, release, and
community work — not dispatcher internals. After today, the
**dispatcher itself** is substantially feature-complete for the
MVP:

- Sequential mode (Phase 1) — still the default
- Verification gate + reviewer (Phase 1)
- Multi-provider routing (Phase 2)
- Dispatcher generality across non-dogfood projects (Phase 3)
- auto_merge=false accumulator for minimal-human-interaction
  sessions (Phase 3 closure tail)
- Fast-fail backoff against broken engineer_commands (gs-193)
- Hot-reload projects.yaml mid-session (gs-191)
- Queue-time hands_off gate (gs-195)
- Stack-aware bootstrap for non-Bun projects (gs-190)
- Parallel worktrees at N slots (Phase 4)

The `anti-slop, opt-in, local-first, BYOK, safe-to-hands-off`
design principles from the pivot are all now expressed in
working code, with 1099 tests backing them. What remains is
surface (UI, docs, release) — not core.
