# Usage budget

GeneralStaff can cap how much of your LLM subscription / API credit a
session consumes. Set a dollar, token, or cycle cap in `projects.yaml`;
the dispatcher reads your actual consumption from the provider and
stops new cycles when you hit the cap.

The feature is optional. If you don't configure a `session_budget`
block, sessions run to their existing `cycle_budget_minutes`
wall-clock cap as before.

## Why

GS runs on your subscription. Claude Code's 5-hour rolling window,
your Anthropic API account, your OpenRouter credits, whichever you
already pay for is what a GS session spends. Without a
consumption-side cap, an unattended overnight run can silently burn
through your Claude Code window and leave you unable to use Claude
for your own interactive work the next morning, or rack up an
unexpected API bill.

This is different from Polsia's model. Polsia sells its own credits;
your usage of Polsia-run agents is funded by a separate purchase on
top of whatever LLM access you already bought. GS runs on what you
already have. This feature is how you tell it how much of that to
spend.

Hard Rule 8 (BYOK) puts the economic exposure on the user. This
feature gives you the knob to control it.

## What it does

At each cycle boundary, before starting the next engineer cycle, the
dispatcher asks the provider "how much have I consumed since this
session started?" If the answer is at or above your cap, the session
stops with `stopReason: "usage-budget"`. The current cycle finishes
normally; no cycle gets interrupted mid-flight.

## What it doesn't do

- **Mid-cycle enforcement.** The check fires only at cycle
  boundaries. If a single cycle runs long and blows past the cap
  internally, it still completes. The session stops afterward, not
  during.
- **Pre-cycle cost estimation.** The check is retrospective. The
  dispatcher can't forecast "this next cycle would push us over" and
  preemptively skip it; it sees the overshoot only after the fact.
  Practical consequence: with a hard-stop cap, the last cycle of a
  session typically overshoots by one cycle's worth of spend. Set
  the cap slightly below your ceiling.
- **Auto-purchase.** If you hit the cap, the session stops. It does
  not top up your OpenRouter balance, renew your Claude Code window,
  or escalate to a paid model.

## Config

Add a `session_budget` block under `dispatcher` in `projects.yaml`
for a fleet-wide cap:

```yaml
dispatcher:
  state_dir: ./state
  max_cycles_per_project_per_session: 3
  session_budget:
    # Pick exactly ONE unit. Setting multiple is a validation error.
    max_usd: 5.00

    # Optional. Default: "hard-stop"
    enforcement: hard-stop   # "hard-stop" (default) or "advisory"

    # Optional. Default: auto-detect
    provider_source: claude-code
```

Or under a single project entry for a per-project cap:

```yaml
projects:
  - id: big-experiment
    priority: 2
    # ...
    session_budget:
      max_usd: 2.00
      on_exhausted: skip-project   # default for per-project: drop
                                   # this project from the picker,
                                   # keep session running on others
```

### Unit options

Pick one per budget block:

| Key | Unit | Typical use |
|---|---|---|
| `max_usd` | U.S. dollars of spend | API + OpenRouter users who bill per-token; session costs cleanly |
| `max_tokens` | Total tokens consumed (input + output + cache) | Token-focused accounting, model-agnostic |
| `max_cycles` | Number of completed cycles | Simplest. Cap by count of dispatcher cycles; no provider read required. |

`max_usd` and `max_tokens` require a provider reader that reports
that unit (see [Provider readers](#provider-readers) below).
`max_cycles` works everywhere, because it's counted from the
dispatcher's own cycle log, not the provider.

### Enforcement modes

**`hard-stop` (default).** Session stops as soon as consumption is
at or above the cap. `stopReason: "usage-budget"` recorded in the
`session_complete` event. Shows up in `session-report` and the
fleet digest.

**`advisory`.** The check still runs, and a warning lands in the
log and in PROGRESS.jsonl, but the session continues to its natural
end. Useful when you want to learn what your sessions actually cost
before committing to a binding cap.

### Per-project within fleet-wide

Both can be set. Per-project applies *within* fleet-wide:

- Fleet cap `$5.00`, project `big-experiment` cap `$2.00`
- `big-experiment` can spend at most `$2.00` before its own cap
  fires
- Fleet-wide `$5.00` still blocks across all projects in the session

Validation rule: a per-project cap cannot exceed the fleet-wide cap
in the same unit. If it does, config load fails with the offending
project + key named.

**`on_exhausted` (per-project only).** When a per-project cap hits
but the fleet-wide cap has headroom, you can choose what the
dispatcher does:

- **`break-session` (default).** Session stops. Matches the
  fleet-wide cap's behavior.
- **`skip-project`.** The project drops off the picker for the rest
  of the session. Other projects keep running until they hit their
  own caps or the fleet-wide cap.

`on_exhausted` is rejected on fleet-wide caps. There's nothing to
fall back to if the fleet budget is exhausted.

## Provider readers

The dispatcher reads consumption from a provider-specific backend
(a `ConsumptionReader` per `src/usage/types.ts`). v1 ships with
Claude Code. The others are stubs awaiting implementation.

| Source | Shipped? | Supports | Notes |
|---|---|---|---|
| `claude-code` | ✓ v1 | `max_usd`, `max_tokens`, `max_cycles` | Reads Claude Code's per-session JSONL via the `ccusage/data-loader` library. Computes the 5-hour rolling-window cost. |
| `openrouter` | roadmap | `max_usd` | Snapshot the `GET /api/v1/credits` balance at session start, diff at each check. |
| `anthropic-api` | roadmap | `max_cycles` | Anthropic API has no clean "remaining quota" endpoint; cycles-only until one exists. |
| `ollama` | roadmap | `max_cycles` | Local + free, always reports zero spend. Cycles-cap for symmetry. |

### Auto-detection

If you don't set `provider_source`, detection order is:

1. `CLAUDE_CONFIG_DIR` env var set, OR default Claude Code config
   dir (`$XDG_CONFIG_HOME/claude`, `~/.config/claude`, or
   `~/.claude`) contains recent JSONL → `claude-code`
2. `OPENROUTER_API_KEY` env var set → `openrouter` *(when shipped)*
3. `ANTHROPIC_API_KEY` env var set → `anthropic-api` *(when shipped)*
4. `OLLAMA_BASE_URL` env var set → `ollama` *(when shipped)*
5. None of the above → fail-open with one WARN per session

### The Claude Code 5-hour window

Claude Code subscriptions throttle per rolling 5-hour block. The
block starts at the hour floor of the first entry (an entry at
14:37 starts a block covering `[14:00, 19:00)`), and a new block
opens when the next entry arrives more than 5 hours after either
the block start or the previous entry.

The reader reports consumption for the **currently active block**.
If your session started mid-block, you'll see pre-session spend
counted against your budget. The provider reads actual account
consumption, not what GS alone produced. This is intentional: the
budget you're capping is your real Claude Code window usage, and
the bot doesn't own that window exclusively.

If this surprises you, the common fix is a fleet-wide
`max_cycles` cap instead. Cycle-count is the one unit that's
dispatcher-local and ignores pre-session spend.

## Fail modes

### Consumption reader unavailable

If the configured reader can't return data (Claude Code daemon not
running, OpenRouter API unreachable, etc.), the session **fails
open**. One WARN line lands in the log:

```
usage budget: consumption data unavailable from <reader>,
proceeding without gating
```

The warning fires once per session, not once per cycle. Cycles run
to their existing `cycle_budget_minutes` cap as if no budget were
set.

Rationale: a hard-stop on missing consumption data would turn
every GS session into a fragile thing that requires provider
reachability to start. The budget is a ceiling, not a gate.

### Consumption data stale

If the reader returns data older than the session's start
timestamp (e.g., Claude Code daemon stopped, JSONL isn't
updating), the dispatcher treats it as "zero new consumption this
session" and proceeds. A WARN lands. The check is best-effort;
this is a known grey area.

### Misconfigured budget

Validation fires at config load, before any session runs. Bad
configs never start a session. Errors name the offending project
+ key:

```
projects.yaml: dispatcher.session_budget: must set exactly one of
max_usd, max_tokens, max_cycles (got: max_usd, max_tokens)
```

## Relation to existing caps

GS already has two session-level caps:

- **`dispatcher.max_cycles_per_project_per_session`**: how many
  cycles a single project can burn per session. Prevents one
  project hogging the whole session.
- **`cycle_budget_minutes`** (per project): wall-clock cap per
  cycle. Stops a stuck engineer.

`session_budget` adds a **consumption-side** cap on top. The three
are orthogonal:

- Wall-clock cap stops a stuck cycle.
- Cycle-count cap balances projects within a session.
- Consumption cap stops the session when your bill or your
  rolling-window headroom is spent.

A session stops on whichever fires first.

## Reading results

`session_complete` events in `state/_fleet/PROGRESS.jsonl` carry a
`consumption_summary` field:

```jsonl
{"event":"session_complete","data":{"stopReason":"usage-budget","consumption_summary":{"total_usd":5.12,"total_tokens":847230,"cycles_used":8,"budget_remaining":0}}}
```

`bun src/cli.ts session-report` surfaces budget-stop sessions with
their own header so they're easy to scan. A budget-exhausted
session isn't a failure; it's the cap doing its job.

## See also

- [`docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md`](../internal/USAGE-BUDGET-DESIGN-2026-04-21.md):
  the full design doc including test matrix, open questions, and
  the multi-provider roadmap.
- [`docs/integrations/basecamp.md`](../integrations/basecamp.md):
  adjacent OAuth-handling pattern if you're setting up OpenRouter
  credentials. OpenRouter keys live in `.env` under
  `OPENROUTER_API_KEY`, the same way Basecamp stores its
  `BASECAMP_CLIENT_ID` / `BASECAMP_CLIENT_SECRET`.
