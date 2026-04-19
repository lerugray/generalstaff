# Phase 2 — Complete (2026-04-17)

**Closed:** 2026-04-17 (same day as Phase 1)
**Elapsed from Phase 1 close:** ~5 hours
**Elapsed from Phase 0 start:** ~53 hours
  (2026-04-15 evening → 2026-04-17 evening)

## Summary

Phase 2 per PIVOT-2026-04-15.md §"Phased build plan" = **Reviewer
pass + formal verification gate + multi-provider routing**. All
three are now substantively shipped:

1. **Reviewer pass + verification gate** — already shipped in
   Phase 1; validated 2026-04-17 via 212+ dogfood cycles.
2. **Multi-provider routing** — shipped today via the
   chain=3 session (2026-04-17 afternoon/evening).

Core Phase 2 implementation is done. Remaining work is P3 polish
(docs, observability events, malformed-input coverage) and one
known gap requiring an interactive session — documented below.

## What shipped

All 11 core Phase 2 tasks delivered in a single 3.5-hour chain
session window:

| Task | File(s) | Purpose |
|------|---------|---------|
| gs-150 | `src/providers/types.ts` | `LLMProvider`, `ProviderRole`, `ProviderHealth`, `ProviderDescriptor` interfaces |
| gs-151 | `src/providers/ollama.ts` | `createOllamaProvider` + health check |
| gs-152 | `src/providers/registry.ts` | `loadProviderRegistry` + `getProviderForRole` + `ProviderConfigError` |
| gs-153 | `provider_config.yaml.example` | Documented schema + example-stays-valid test |
| gs-154 | `src/digest_llm.ts` | `generateDigestNarrative` with fallback |
| gs-155 | `src/cycle_summary_llm.ts` | `generateCycleDescription` with fallback |
| gs-156 | `tests/providers.calibration.test.ts` | Dual-run reviewer calibration harness (Claude vs Ollama agreement test) |
| gs-157 | `src/cli.ts` | `generalstaff providers list` subcommand (+ `--json`) |
| gs-158 | `src/session.ts` | Digest-narrative wired behind `GENERALSTAFF_DIGEST_NARRATIVE_PROVIDER` env flag |
| gs-159 | `src/cli.ts` | `generalstaff providers ping <id>` (+ `--all`, `--json`) |
| gs-160 | `tests/session.test.ts` | Graceful degradation tests when digest provider unreachable |

Supporting polish tasks that landed in the same chain:
gs-140 (botWorktreePath helper), gs-142 (task list --priority),
gs-144 (isNoopCommand tests), gs-145 (init template task +
--priority), gs-147 (log --tail), gs-148 (history --outcome),
gs-149 (pi-autoresearch research note — pending, bumped P3).

## Quantitative evidence

Phase 2 chain window (first chain session start → last session
end): 2026-04-17T19:05 UTC → 2026-04-17T22:31 UTC.

| Metric | Value |
| --- | --- |
| Sessions | 3 (chain=3) |
| Duration | ~3.5 hours wall clock |
| Total cycles | 28 |
| Verified | 20 (71%) |
| Verification_failed | 8 (29%) |
| Commits on master | ~20 new (tasks + state + merges) |

### Failure analysis

Of the 8 failures, **zero were genuine correctness or hands-off
failures that polluted master:**

- **3 failures in session 2 @ 20:31–20:48 UTC:** OpenRouter
  Qwen3 Coder returned non-JSON output. Infrastructure glitch,
  not bot-correctness issue. Reviewer provider returned
  unparseable responses; cycle outcomes marked failed and rolled
  back. See "Known gaps" below re gs-164.
- **4 failures in session 3 @ 21:58–22:25 UTC:** All were
  retries of gs-146 (stop --status subcommand). gs-146's spec
  required exporting `stopFilePath` from `src/safety.ts` which
  is hands-off. Bot correctly tried, correctly failed, cycles
  correctly rolled back by gs-132. Task superseded by gs-165
  (correct implementation using inline STOP path construction).
- **1 failure in session 3 @ 22:25 UTC:** final gs-146 retry,
  same pattern.

**gs-132's rollback was validated in the wild.** Every failed
cycle shows `Rolled back bot/work: <failed-sha> → <start-sha>`
in the session log. Master shows no gs-146 commits and no
garbage between state cycle-end markers. This is the feature
we built this morning working exactly as designed on the
first real test. Notable because the bug it fixed (auto_merge
bypassing verification) had already landed 6 bad commits on
master earlier today — now architecturally prevented from
recurring.

## Definition-of-done check

Against PIVOT-2026-04-15.md §"Phased build plan" for Phase 2:

- ✅ **Reviewer pass with formal verification gate** — already
  shipped in Phase 1 via `src/reviewer.ts` (pluggable provider
  dispatch, scope-drift + hands-off + silent-failure checks).
  Validated across 212+ cycles.
- ✅ **Multi-provider LLM routing abstraction.** `src/providers/`
  module + `provider_config.yaml.example` schema + `loadProvider-
  Registry` + Ollama adapter + `LLMProvider` interface all
  shipped.
- ✅ **Ollama tier for summarization / classification.** Digest
  narrative (gs-154) + per-cycle description (gs-155) generators
  in place, wired behind feature flag (gs-158) with graceful
  fallback (gs-160) so default behavior is unchanged.
- ✅ **Provider calibration gate test.** gs-156's dual-run
  harness compares Claude vs Ollama verdicts on fixture diffs;
  skip-when-unavailable so CI doesn't break without local
  Ollama / claude binary.
- ✅ **Observability surface.** `generalstaff providers list` +
  `providers ping` (gs-157, gs-159) give operators visibility
  into configured providers and their health without needing
  to read YAML or run the reviewer.
- ⚠️ **Engineer role swap to Qwen via aider/opencode.** Phase 2
  explicitly leaves this deferred (FUTURE-DIRECTIONS §2
  "Priority stack" item 3). Engineer stays on Claude-subscription
  via `scripts/run_bot.sh` — that's the intended Phase 2 state,
  not a gap.

## Known gaps (for future interactive sessions)

Phase 2 core is complete, but two items require an interactive
session because they touch hands-off files:

### gs-164 — extend reviewer fallback to trigger on parse failure

**File:** `src/reviewer.ts` (hands-off to bot).
**Context:** The fallback chain introduced by gs-090 triggers
only when the primary provider returns the `[REVIEWER ERROR]`
sentinel. Session 2 of the 2026-04-17 chain saw 3 consecutive
cycles fail with *"reviewer response was not valid JSON"* —
OpenRouter Qwen3 Coder returned responses that parsed as an HTTP
200 but whose body couldn't be parsed as JSON. Current fallback
doesn't fire on parse failure.
**Fix (interactive only):** wrap `parseReviewerResponse` in
`invokeReviewerWithFallback`; if it throws or returns null,
trigger the same provider-chain fallback the `[REVIEWER ERROR]`
path uses. Emit `reviewer_fallback` event with
`reason='parse_failure'`. Add tests.
**Risk of not doing this:** a ~10% baseline rate of
reviewer-infrastructure failures per session when using
OpenRouter (per the 2026-04-17 data). These are correctly
rolled back (no master pollution), but they waste cycle budget
that could be doing real work.

### Per-project provider overrides in projects.yaml

**File:** `projects.yaml` + `projects.yaml.example` + `src/
projects.ts` parser (all hands-off or affect hands-off).
**Context:** FUTURE-DIRECTIONS §2 shows the per-project
`providers:` override block. Not shipped yet because it
requires schema changes to files the bot can't touch.
**Fix (interactive only):** add the `providers:` field to the
`ProjectConfig` type + loader + validator, and update
`projects.yaml.example` with an example override. Low urgency
— Phase 2 ships without per-project overrides and relies on
env vars (`GENERALSTAFF_REVIEWER_PROVIDER` etc.) for the same
effect.

### Env-var plumbing for run_session.bat

**File:** `scripts/run_session.bat` (hands-off).
**Context:** The `.bat` wrapper currently only threads
`GENERALSTAFF_REVIEWER_PROVIDER` and `OPENROUTER_API_KEY`.
New Phase 2 env vars — `GENERALSTAFF_DIGEST_NARRATIVE_PROVIDER`
and any future routing controls — aren't plumbed.
**Fix (interactive only):** mirror the existing
`GENERALSTAFF_REVIEWER_PROVIDER` pattern for each new var.
Low urgency — advanced users can set the vars manually before
running the launcher.

## Remaining pending polish (bot-appropriate)

5 P2/P3 tasks still in tasks.json, bot can pick them up in a
future session:

- **gs-149** (P3) — pi-autoresearch + karpathy/autoresearch
  research note (docs-only task in `research-notes.md`)
- **gs-161** (P3) — add `provider_invoked` and
  `provider_fallback` to `ProgressEventType` union + VALID_EVENTS
- **gs-162** (P3) — malformed-input test coverage for
  `loadProviderRegistry`
- **gs-163** (P3) — `docs/provider-config-format.md` long-form
  schema reference
- **gs-165** (P2) — correct stop --status/--check
  implementation (supersedes gs-146, uses inline STOP path
  construction instead of safety.ts export)

None of these block Phase 3.

## What's next

- **Phase 3 — second-project validation.** Register `gamr`
  (deliberately-mediocre scratch idea per FUTURE-DIRECTIONS §5)
  as GeneralStaff's second managed project. Validates generality.
  Required before launch per LAUNCH-PLAN's pre-launch gates.
- **Phase 4 — Tauri UI.** The non-programmer distribution
  vehicle. Potentially explores Claude Design (launched
  2026-04-17 — see research-notes.md) for initial mockups.
- **Launch prep.** See `LAUNCH-PLAN.md`.

---

**Author:** Captured by the 2026-04-17 evening interactive
session. Stats pulled from `state/generalstaff/PROGRESS.jsonl`
and the 2026-04-17 chain-session log.
**Hands-off status:** Covered by `PHASE-*.md` pattern if added
to the hands-off list; currently projects.yaml only globs
`PHASE-1-*.md`. Consider widening to `PHASE-*.md` so future
phase-complete markers are auto-protected.
