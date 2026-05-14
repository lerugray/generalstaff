# GS Pre-Cycle Advisor (Hammerstein)

Optional pre-cycle audit layer. When enabled, GS calls an external
advisor (default: [Hammerstein CLI](https://github.com/lerugray/hammerstein))
between picker and engineer, with the proposed task plan + bounded
cycle history. The verdict lands in PROGRESS.jsonl as an
`advisor_verdict` event.

> Status: v1, landed 2026-05-14 (gs-327). Single-provider (Hammerstein
> via `h` CLI). v2 may add direct OpenRouter / Claude / Ollama routing
> inside GS.

## Why

GS's verification gate catches problems after the engineer runs (tests
fail, diff empty, scope drift, hands-off violation). The advisor
catches problems *before* the engineer runs (scope too vague, recent
cycles already failed at the same pattern, the task touches paths the
hands-off list will reject anyway).

It's a separate question from "did this cycle succeed" — it's "should
we even start this cycle." That's exactly the strategic-reasoning
question Hammerstein is tuned for. The
[Strategic-reasoning companion](../README.md#strategic-reasoning-companion)
section in the README documents the manual `h audit "<plan>"` pattern
for plans you write outside GS; the advisor wires the same shape into
the dispatcher.

## Configuration

Per-project in `projects.yaml`:

```yaml
projects:
  - id: retrogaze
    # ... usual fields ...
    advisor:
      enabled: true        # default: false (no overhead)
      gate: false          # default: false (advisory only; verdict logged but cycle proceeds)
      provider: hammerstein  # only "hammerstein" in v1
      timeout_seconds: 90    # default 90 (h audit typically ~60s)
      history_cycles: 3      # default 3 (bounded; audit recommendation)
```

### `enabled: false` (default)

Zero overhead. Advisor never runs. Existing behavior unchanged.

### `enabled: true, gate: false` (recommended for first deployment)

Advisor runs pre-cycle. Verdict logged to PROGRESS.jsonl. The cycle
ALWAYS proceeds regardless of verdict. Use this to validate the
advisor is giving useful verdicts on your project's task shape before
committing to gating mode.

### `enabled: true, gate: true`

Advisor runs pre-cycle. If the verdict is `block`, the cycle is
skipped (final_outcome=`cycle_skipped`, reason=`advisor_gated: …`).
The skipped task stays bot-pickable for the next cycle — the gate is
informational refusal, not task-rejection.

## Verdict types

Verdict | Meaning | Cycle action (gate: true)
---|---|---
`proceed` | Plan looks fine. | Run engineer.
`revise` | Plan needs revision before running. | Run engineer (advisory only — v1 doesn't auto-revise).
`block` | Don't run this cycle. | Skip cycle (`advisor_gated`).
`timeout` | Advisor exceeded `timeout_seconds`. | Run engineer (proceed on timeout).
`error` | Advisor failed (CLI not installed, parse error, malformed output, etc.). | Run engineer (fail open).

## Setup

```bash
# Install Hammerstein CLI (Python package, MIT)
pipx install hammerstein
# OR: pip install --user hammerstein

# Verify
h --version
h audit "test plan: refactor login.py to extract validators"
```

The `h` CLI handles its own provider routing (OpenRouter Qwen3.6,
DeepSeek, Ollama fallback per the project README). GS doesn't need
provider config for Hammerstein — it just shells out. BYOK is
inherited: the user's existing `OPENROUTER_API_KEY` etc. drives
Hammerstein's routing.

## Output

Per-cycle PROGRESS.jsonl gains one new event per advisor run:

```json
{
  "timestamp": "2026-05-14T08:00:23.456Z",
  "event": "advisor_verdict",
  "cycle_id": "20260514080020_abcd",
  "project_id": "retrogaze",
  "data": {
    "task_id": "rg-247",
    "verdict": "proceed",
    "reason": "Plain English summary line from advisor output",
    "provider": "hammerstein",
    "duration_sec": 58.3,
    "raw_output": "<truncated to 4000 chars>"
  }
}
```

Grep + jq your way through the audit log:

```bash
# All advisor verdicts in the last week
grep '"event":"advisor_verdict"' state/<project>/PROGRESS.jsonl

# Count block / revise / proceed
grep '"advisor_verdict"' state/<project>/PROGRESS.jsonl \
  | jq -r '.data.verdict' | sort | uniq -c
```

## Latency

A single `h audit` call against OpenRouter Qwen3.6-plus runs ~60s.
That latency is added to every cycle when advisor is enabled. On a
fleet running 10 cycles/hour, that's 10 minutes/hour of advisor wait
— acceptable if cycles are 10-15 min anyway, expensive if cycles are
30s mechanical jobs.

Tune `timeout_seconds` to fail fast if you don't want the worst case
to dominate.

## Failure modes

- **Hammerstein CLI not installed.** Verdict = `error`, reason
  explains how to install. Cycle proceeds. Configure `enabled: false`
  if you don't want the warning every cycle.
- **Network down / OpenRouter rate-limited.** Hammerstein's own
  provider fallback kicks in (DeepSeek → Ollama). If all fail, h
  CLI exits nonzero. Verdict = `error`. Cycle proceeds.
- **Hammerstein output malformed.** Heuristic parser can't extract
  verdict. Verdict = `error`. Cycle proceeds.
- **Timeout.** Verdict = `timeout`. Cycle proceeds.

The advisor is **fail-open by design** — its job is to add a
pre-cycle sanity check, not to block when it can't speak. The
verification gate AFTER the cycle is still the load-bearing thing.

## Rollback

Set `advisor.enabled: false` in projects.yaml. No state migration.

## Comparison: advisor vs reviewer

Both are auditors. They live at different points in the pipeline.

Property | Advisor (this) | Reviewer
---|---|---
When it runs | Before engineer | After engineer
What it sees | Task plan + history | Diff + verification result
Question it answers | Should we start? | Did the engineer do what was asked?
Default | Off (opt-in) | On (load-bearing gate)
Latency added | ~60s per cycle | depends on provider
Blocks cycle | Only with `gate: true` | Always (verification_failed = rollback)
Provider | Hammerstein CLI (v1) | claude / openrouter / ollama
BYOK | Inherited from Hammerstein's config | GS provider_config.yaml

You'd want both for high-stakes projects: advisor catches "this plan
is shaped wrong," reviewer catches "the engineer did the wrong work."
For low-stakes / mechanical work, just the reviewer is usually enough.

## v2 candidates

- **Direct multi-provider support.** Run advisor without the
  Hammerstein CLI — GS reaches OpenRouter / Claude / Ollama directly
  with an audit-this-plan system prompt. Defers Hammerstein-doctrine
  to the user.
- **Async advisor mode.** Run advisor in the background; log verdict
  asynchronously. Trade verdict-affects-this-cycle for zero added
  latency.
- **Per-task advisor opt-out.** A task-level `skip_advisor: true`
  flag for tasks that don't benefit from auditing (mechanical
  fixture updates, etc.).
- **Advisor-driven task rewrite.** If verdict is `revise`, capture
  the revised plan back into tasks.json for next cycle to pick up.

These aren't shipped. Open an issue if any of them block a use case
you have.
