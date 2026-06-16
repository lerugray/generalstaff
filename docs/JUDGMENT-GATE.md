# GS Pre-Cycle Judgment Gate (Hammerstein slop screen)

Optional, lightweight pre-execution gate. After the picker resolves the
next task and before the engineer spends a cycle's tokens, GS runs the
canonical Hammerstein system-prompt against the picked task and asks one
focused question: is this task **load-bearing** toward the project goal,
or **stupid-industrious** slop (effort that pattern-matches progress but
doesn't advance it)? Verdict KEEP / REJECT, logged to PROGRESS.jsonl as a
`judgment_verdict` event.

> Status: landed 2026-06-16 (gs-330), shipped in v0.7.0. Inline OpenRouter
> — no external binary required. Proved out in the
> [`wintermute`](https://github.com/lerugray/hammerstein) experiment, which
> showed the gate reliably separates load-bearing from slop on clear-cut
> cases and is genuinely contestable only on borderline items — hence
> flag-first, never a hard veto by default.

## Why

GS's verification gate catches problems *after* the engineer runs (tests
fail, diff empty, scope drift, hands-off violation). The reviewer asks
"did the engineer do the work correctly?" — but nothing asks "was this
task even worth doing?" Today the bot can spend a full cycle writing
correct code for a wrong-shaped task and the reviewer passes it. The
judgment gate fills that gap: it screens **task shape** before the cycle
starts.

This is GeneralStaff eating its own dogfood. GS *is* the Hammerstein
framework applied to autonomous dev work; the gate applies it to the
bot's own task selection.

It earns its keep most where tasks are vaguer or **auto-generated**
(greenfield mode, autonomous task-gen), where slop sub-goals actually
appear. For a hand-curated `tasks.json` (you write good tasks), it's
mostly a no-op safety net — it rarely fires.

## Configuration

Per-project in `projects.yaml`, a single string field:

```yaml
projects:
  - id: generalstaff
    # ... usual fields ...
    judgment_gate: flag    # off (default) | flag | skip
```

### `off` (default)

Zero overhead. The gate never runs. Existing behavior unchanged. The
global default is `off` so upgrading users get no surprise external
calls.

### `flag` (recommended dogfood setting)

The gate runs pre-cycle. Verdict logged to PROGRESS.jsonl. The cycle
**always proceeds** regardless of verdict (advisory). Use this to
validate the gate gives useful verdicts on your project's task shape
before committing to skip mode.

### `skip`

The gate runs pre-cycle. On a **REJECT**, the cycle is skipped
(final_outcome=`cycle_skipped`, reason=`judged_stupid_industrious: …`).
The skipped task stays bot-pickable for the next cycle — the gate is
informational refusal, not task-deletion. Reach for `skip` only on
autonomous / auto-generated task pipelines where slop sub-goals actually
appear.

## Verdict types

Verdict | Meaning | Cycle action (`skip` mode)
---|---|---
`keep` | Task is load-bearing toward the goal. | Run engineer.
`reject` | Task reads as stupid-industrious slop. | Skip cycle (`judged_stupid_industrious`).
`error` | Gate couldn't speak (no key, fetch failure, timeout, unparseable verdict). | Run engineer (fail open).

Under `flag` mode, every verdict proceeds — only the logging differs.

## Setup

The gate calls OpenRouter directly — no binary to install. It needs only
`OPENROUTER_API_KEY` in your environment (the same key the OpenRouter
reviewer path already uses):

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Model defaults to `qwen/qwen3.6-plus` (~$0.001/task; what wintermute
validated). Override with `GENERALSTAFF_JUDGMENT_GATE_MODEL`. The
vendored Hammerstein system-prompt lives at
`src/prompts/hammerstein_gate.md` (copied verbatim from the public,
AGPL-3.0 [Hammerstein framework](https://github.com/lerugray/hammerstein));
point `GENERALSTAFF_JUDGMENT_GATE_PROMPT` at another file to swap it.

## Output

Per-cycle PROGRESS.jsonl gains one new event per gate run:

```json
{
  "timestamp": "2026-06-16T18:00:23.456Z",
  "event": "judgment_verdict",
  "cycle_id": "20260616180020_abcd",
  "project_id": "generalstaff",
  "data": {
    "task_id": "gs-247",
    "verdict": "keep",
    "reason": "Reproduce-fix-verify is the minimal load-bearing path.",
    "quadrant": "clever-lazy",
    "model": "qwen/qwen3.6-plus",
    "duration_sec": 3.2,
    "mode": "flag",
    "raw_output": "<truncated to 4000 chars>"
  }
}
```

Grep + jq your way through the audit log:

```bash
# All gate verdicts
grep '"event":"judgment_verdict"' state/<project>/PROGRESS.jsonl

# Count keep / reject / error
grep '"judgment_verdict"' state/<project>/PROGRESS.jsonl \
  | jq -r '.data.verdict' | sort | uniq -c
```

## Latency & cost

A single gate call against OpenRouter `qwen/qwen3.6-plus` runs ~10-20s
(the model reasons before answering) and costs well under a cent
(~$0.002). That's added to every cycle when the gate is enabled — still
meaningfully lighter than the external-CLI advisor (~60s). The call is
bounded by a 60s AbortController timeout; on timeout the verdict is
`error` and the cycle proceeds. Use a faster/cheaper model via
`GENERALSTAFF_JUDGMENT_GATE_MODEL` if the per-cycle latency bites.

## Failure modes

- **`OPENROUTER_API_KEY` not set.** Verdict = `error`, reason explains.
  Cycle proceeds. Set `judgment_gate: off` to silence.
- **Network down / OpenRouter rate-limited / non-200.** Verdict =
  `error`. Cycle proceeds.
- **Response malformed / no VERDICT line.** Verdict = `error`. Cycle
  proceeds.
- **Timeout (>60s).** Verdict = `error`. Cycle proceeds.

The gate is **fail-open by design** — only an explicit REJECT under
`skip` mode ever blocks a cycle. The verification gate AFTER the cycle is
still the load-bearing correctness check.

## Rollback

Set `judgment_gate: off` (or remove the field) in projects.yaml. No state
migration.

## Comparison: judgment gate vs advisor vs reviewer

All three are auditors at different points in the pipeline.

Property | Judgment gate (this) | Advisor ([ADVISOR.md](ADVISOR.md)) | Reviewer
---|---|---|---
When it runs | Before engineer | Before engineer | After engineer
What it sees | Picked task + project goal | Task plan + cycle history | Diff + verification result
Question | Is this task the right *shape*? | Should we start this cycle? | Did the engineer do what was asked?
Backend | OpenRouter **inline** (no binary) | External `h` CLI on PATH | claude / openrouter / ollama
Default | Off (opt-in) | Off (opt-in) | On (load-bearing gate)
Latency added | ~10-20s/cycle | ~60s/cycle | depends on provider
Blocks cycle | Only `skip` + REJECT | Only `gate: true` + block | Always (verification_failed = rollback)
BYOK | `OPENROUTER_API_KEY` | Inherited from Hammerstein's config | GS provider_config.yaml

The judgment gate is the **light, self-contained** pre-cycle option: a
focused KEEP/REJECT slop screen that needs no external binary. The
advisor is the **heavier, broader** pre-cycle audit (scope drift,
hands-off, history) via the full Hammerstein CLI. They compose — both can
be enabled. For most projects the judgment gate alone is the right
pre-cycle layer; reach for the advisor when you want the fuller audit.

## v2 candidates

- **Frontier-model gate run.** The wintermute result is single-model
  (`qwen3.6-plus`) on a toy goal; a frontier-model pass would show
  whether the borderline boundary sharpens.
- **Per-task opt-out.** A task-level flag for tasks that don't benefit
  from screening (mechanical fixture updates, etc.).
- **Richer task context.** GreenfieldTask carries no description body in
  v1; the gate judges from the title + project goal. A `description`
  field would give the gate more to work with.

These aren't shipped. Open an issue if any of them block a use case you
have.
