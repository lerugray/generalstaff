# Usage-Budget Feature — Design Spec (2026-04-21)

## Motivation

Autonomous dispatcher + LLM provider + user-defined work queue is
the GS model. One axis we don't currently track: **how much of the
user's LLM subscription each session consumes**.

This matters because:

- **Claude Code subscriptions have a 5-hour rolling window.** Users
  can do X amount of work, then they're throttled for ~5 hours.
  A bot session that runs in the background can silently burn
  through the user's window, leaving them unable to use Claude
  for their own interactive work.
- **Anthropic API usage bills per-token.** API users have an
  actual dollar cost attached to every cycle. Without a budget,
  an overnight GS session can produce a surprise bill.
- **OpenRouter users work from a credit balance.** Different
  abstraction, same need: know what you're spending.
- **Hard Rule 8 (BYOK)** puts the economic exposure on the user.
  GS should expose the same surface for controlling it.

**User-stated goal** (Ray 2026-04-21):

> "It would be great if users could set limits on bot runs
> relative to their usage. The bots can stop if there's no
> valuable work left to be done, but a user could say they are
> okay with [N amount] of their usage being burned via automated
> projects."

Current GS has `cycle_budget_minutes` (wall-clock cap) and
`max_cycles_per_project_per_session` (cycle-count cap). What's
missing is a **consumption-side cap** — stop when we've spent
the user's allotted budget, regardless of how much wall-clock
or how many cycles remain.

## Polsia differentiator (corrected)

Polsia sells its own credit system — users purchase Polsia credits
which fund Polsia-run agents. GS is architecturally different:
**GS runs on the user's own subscription/API/credits.** This
feature makes that difference economically tangible:

> "GS runs on the subscriptions you already have — your Claude
> Code plan, your Anthropic API key, your OpenRouter credits.
> Polsia requires a separate credit purchase on top of whatever
> LLM access you already bought. The usage-budget feature lets
> you cap how much of your existing capacity GS consumes."

Earlier framings around "Polsia ignores your quota" were
inaccurate — Polsia caps via their own credits. The accurate
differentiator is economic: you don't pay twice.

## Design overview

User configures a **session allowance** in a unit of their choice
(dollars, cycles, or tokens — see §Config). GS reads
consumption via a **provider-specific backend**, compares against
the allowance, and **hard-stops new cycles** when the allowance
would be exceeded. Mid-cycle enforcement is out of scope for v1
(too invasive); the check fires at cycle boundaries only.

```
                         ┌──────────────────────┐
                         │  DispatcherConfig    │
                         │  - session_budget_*  │
                         └──────────┬───────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Session loop (src/session.ts)            │
│                                                             │
│  for each cycle:                                            │
│    ┌──────────────────────────────────────────┐             │
│    │ consumption_so_far = backend.read()      │             │
│    │ if consumption_so_far >= budget:         │             │
│    │   stopReason = "budget"                  │             │
│    │   break                                  │             │
│    └──────────────────────────────────────────┘             │
│    execute_cycle()                                          │
└─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │  Consumption backend   │
                       │  (provider-specific)   │
                       └────────────────────────┘
                         │            │
                         ▼            ▼
                 Claude Code       OpenRouter
                 JSONL reader      API query
                 (ccusage-like)    (credit balance)
```

## Config surface

`projects.yaml` dispatcher section:

```yaml
dispatcher:
  # Existing
  state_dir: ./state
  max_cycles_per_project_per_session: 3
  # New — usage budget (all optional, default is no cap)
  session_budget:
    # Pick ONE of these units. Setting multiple is a validation error.
    max_usd: 5.00              # stop when session cost exceeds $5.00
    # max_tokens: 500000         # stop when session token consumption exceeds 500k
    # max_cycles: 10             # stop when session cycle count exceeds 10 (today's max_cycles_per_project_per_session scales across projects)
    
    # Optional advisory mode — run past the cap but log a warning
    mode: hard-stop            # "hard-stop" (default) | "advisory"
    
    # Optional provider override for consumption reading
    # Defaults to auto-detect (Claude Code JSONL, then OpenRouter API, etc)
    consumption_source: claude-code
```

Per-project override in `projects.yaml`:

```yaml
projects:
  - id: big-experiment
    session_budget:
      max_usd: 2.00              # this project capped at $2 of the $5 fleet-wide budget
```

**Precedence rule:** per-project cap applies *within* fleet-wide
cap. If fleet budget = $5 and project budget = $2, the project
gets max $2, and the fleet-wide budget still blocks at $5 across
all projects in the session.

**Validation rules:**
- Exactly one of `max_usd` / `max_tokens` / `max_cycles` may be
  set per budget block. Setting multiple is a config error.
- `mode` defaults to `hard-stop`.
- Per-project `max_*` cannot exceed fleet-wide `max_*` (if both
  set). Validation fails at config load.
- Setting no `session_budget` block at all = no budget cap
  (current default behavior preserved).

## Provider abstraction layer

New module `src/usage/` holds provider-specific consumption
readers behind a shared interface:

```typescript
// src/usage/types.ts
export interface ConsumptionReader {
  name: string;
  
  // Returns consumption since session_start_timestamp.
  // Units are inherent to the reader:
  //   usd, tokens, cycles
  readSessionConsumption(sessionStart: Date): Promise<{
    usd?: number;
    tokens?: number;
    cycles?: number;
    source: string;
    read_at: Date;
  }>;
  
  // Can this reader provide a given unit?
  supports(unit: "usd" | "tokens" | "cycles"): boolean;
}
```

### Per-provider implementations

**`src/usage/claude_code.ts`** — reads Claude Code's JSONL session
logs. Approach:

- Locate Claude Code data dir (platform-specific: `~/.config/claude/` on linux, `%APPDATA%\claude\` on Windows, `~/Library/Application Support/claude/` on macOS — verify against ccusage's approach)
- Parse JSONL per-session files (format has `timestamp`, `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `model`, and cost data when present)
- Filter to entries after `sessionStart`
- Aggregate tokens + cost
- Supports: `usd`, `tokens`, `cycles` (count of JSONL entries post-sessionStart)

**`src/usage/openrouter.ts`** — queries OpenRouter API for credit
balance. Approach:

- GET `https://openrouter.ai/api/v1/credits` (requires API key)
- Compare against snapshot taken at session start
- Supports: `usd` only

**`src/usage/anthropic_api.ts`** — lighter version. Anthropic
doesn't publish a clean "remaining quota" API, so this reader
tracks cycles only (count of `executeCycle` invocations
post-sessionStart) and leaves usd estimation as an open
question.

- Supports: `cycles` only (for now)

**`src/usage/ollama.ts`** — Ollama is local + free. Reader always
returns zero consumption. Supports: `cycles` only (for symmetry).

### Reader auto-detection

`DispatcherConfig.session_budget.consumption_source` can be
explicit. If absent, default detection order:

1. If `CLAUDE_CODE_SESSION_FILE` env var is set OR default Claude
   Code data dir contains recent JSONL → use `claude-code`
2. Else if `OPENROUTER_API_KEY` is set → use `openrouter`
3. Else if `ANTHROPIC_API_KEY` is set → use `anthropic-api`
4. Else if `OLLAMA_BASE_URL` env is set → use `ollama`
5. Else: fail-open (log warning, proceed without gating)

## Enforcement semantics

### Hard-stop (default)

At each cycle boundary (before calling `executeCycle`):

```typescript
const consumption = await reader.readSessionConsumption(sessionStart);
const budget = config.session_budget;
if (budget.max_usd !== undefined && consumption.usd >= budget.max_usd) {
  stopReason = "budget";
  await appendProgress("_fleet", "session_budget_exceeded", {
    unit: "usd",
    budget: budget.max_usd,
    consumed: consumption.usd,
    source: consumption.source,
  });
  break;
}
// (parallel branches for max_tokens / max_cycles)
```

The new `stopReason` value `"budget"` joins the existing set:
`"budget" | "max-cycles" | "stop-file" | "no-project" | "insufficient-budget" | "empty-cycles"`. Surfaces in `session-report` CLI and fleet-level `session_complete` event.

### Advisory mode

Same check runs, but instead of breaking, logs a warning and
continues:

```typescript
if (consumption.usd >= budget.max_usd && budget.mode === "advisory") {
  console.warn(`Session budget exceeded: spent $${consumption.usd.toFixed(2)} of $${budget.max_usd.toFixed(2)} (advisory mode, continuing)`);
  await appendProgress("_fleet", "session_budget_advisory", { ... });
}
```

Useful for users who want to *know* they exceeded budget (e.g.,
for tuning the cap next time) without blocking runs.

## Fail modes

### Consumption data unavailable

If `reader.readSessionConsumption()` throws or returns null:

- **Default**: fail-open with loud warning. Log one WARN line per
  session: `"usage budget: consumption data unavailable from <reader>, proceeding without gating"`. Cycle runs.
- **Optional future**: `session_budget.fail_mode: "fail-closed"` config lets paranoid users block until consumption data is available.

### Budget misconfigured

Validation fires at config load (before any session runs). Errors
name the offending project + key. Session aborts before any cycle
runs.

### Consumption data stale

If reader returns data older than the session start (e.g., Claude
Code daemon not running, JSONL file not being updated), log a
WARN but treat as "zero new consumption" and proceed. This is a
grey area — hard to distinguish "Claude isn't running right now"
from "Claude ran but consumption file is stale."

## Sub-task breakdown

The feature is ~1-2 weeks focused work total. Six sub-tasks,
roughly in dependency order:

**gs-296 — Provider abstraction + Claude Code JSONL reader (bot-pickable)**
- New `src/usage/` directory with `types.ts`, `claude_code.ts`
- `types.ts` defines `ConsumptionReader` interface + `ConsumptionSnapshot` type
- `claude_code.ts` imports `ccusage/data-loader` (add `ccusage` to dependencies), calls `loadSessionBlockData()`, maps the active block to `ConsumptionSnapshot`, handles source-unavailable case by returning null (session loop converts to fail-open warning)
- Tests mock `ccusage/data-loader` exports and verify the mapping layer — DON'T re-test ccusage itself, that's their test suite's job
- `expected_touches: ["src/usage/", "tests/usage/", "package.json"]`
- ~200-300 LOC (shrunk from 400-600 because ccusage does the heavy lifting)

**gs-297 — DispatcherConfig + ProjectConfig schema (bot-pickable)**
- Add `session_budget` fields to types in `src/types.ts`
- Add validation (exactly-one-unit rule, precedence rule, per-project ≤ fleet-wide rule)
- `expected_touches: ["src/types.ts", "src/projects.ts", "tests/projects.test.ts"]`
- ~200-300 LOC

**gs-298 — Pre-cycle check integration in session loop (interactive)**
- Modify `src/session.ts` to read consumption + gate cycles
- New `stopReason: "budget"` plumbed through session_complete event
- `expected_touches: ["src/session.ts", "tests/session.test.ts"]` — but this touches the core session loop which is dispatcher-adjacent; worth a human eye
- ~150-250 LOC

**gs-299 — Session-end reporting + session-report integration (bot-pickable)**
- Total consumption vs. budget logged in session_complete event
- `session-report` CLI picks up the new stop reason + consumption data
- `expected_touches: ["src/session.ts", "src/session_report.ts", "tests/session_report.test.ts"]`
- ~100-150 LOC

**gs-300 — User-facing docs + README update (interactive)**
- Public-facing docs for the feature under `docs/conventions/` or similar
- README update (brief mention in feature list)
- CLAUDE.md update for new dispatcher config key
- Voice-bearing work; `creative_work_allowed` territory if GS ever flips that on
- Interactive-only

**gs-301 — Test matrix (bot-pickable)**
- Integration tests covering: budget hit → hard-stop, budget hit →
  advisory mode, consumption source unavailable → fail-open with
  warning, per-project cap enforces within fleet cap
- Regression tests confirming existing session behavior unchanged
  when no `session_budget` config is present
- `expected_touches: ["tests/session.test.ts", "tests/usage/", "tests/integration/"]`
- ~300-500 LOC

### Multi-provider expansion (post-v1, not blocking launch)

- `src/usage/openrouter.ts` — OpenRouter API reader
- `src/usage/anthropic_api.ts` — cycles-only reader
- `src/usage/ollama.ts` — zero-cost reader

Each is a separate small task queueable once the v1 Claude-Code
path ships + proves out.

## Implementation order

Suggested order for the first focused session:

1. gs-297 (config schema) first — no other work depends on nothing; unblocks everything below
2. gs-296 (consumption reader) second — adds capability, still no integration
3. gs-298 (session-loop integration) third — where gs-296 + gs-297 actually meet
4. gs-299 (reporting) fourth — user visibility into what the feature did
5. gs-301 (tests) fifth — harden what shipped
6. gs-300 (docs) last — write about what you actually built, not what you planned to build

Order can shift if someone wants to do docs-first TDD-style, but
the consumption-reader-before-integration order is load-bearing.

## Resolved questions (ccusage research, 2026-04-21)

Answers from reading `github.com/ryoppippi/ccusage` source.
These were "open" in the first draft of this doc; captured here
so implementation (gs-296) starts from known ground.

1. **Claude Code JSONL location.** Env-var override is
   `CLAUDE_CONFIG_DIR` (comma-separated for multiple dirs), NOT
   `CLAUDE_CODE_DATA_DIR`. Defaults that coexist and must both
   be probed + deduped:
   - `$XDG_CONFIG_HOME/claude` (fallback `~/.config/claude`) —
     newer default.
   - `~/.claude` — legacy default, still where Windows Claude
     Code writes.
   JSONL glob pattern is `<claudePath>/projects/**/*.jsonl`.
   Project name extracts from the path segment after
   `projects/` — directory-based, not a field in the JSONL
   itself. Windows paths encode cwd with dashes (e.g.
   `C--Users-rweiss-Documents-Dev-Work-generalstaff`).
2. **JSONL line shape.** No top-level `total_tokens_used`.
   Token counts live at `message.usage.{input_tokens,
   output_tokens, cache_creation_input_tokens,
   cache_read_input_tokens}` — sum the four yourself. Model at
   `message.model` (also nested, not top-level). `costUSD` is
   OPTIONAL and version-dependent — newer Claude Code writes
   tokens-only; reader must compute cost from pricing. Dedup
   key tuple: `(message.id, requestId)`.
3. **5-hour window math.** Block-based, not sliding. Block
   starts at `floorToHour(firstEntryTimestamp)` — entry at
   14:37 → block `[14:00, 19:00)`. New block opens when the
   next entry is >5h after block start OR >5h after the
   previous entry. ccusage exposes `loadSessionBlockData`
   returning fully-computed blocks with `{startTime, endTime,
   isGap, cost, tokens, entries}`.
4. **Mixed-model pricing.** ccusage fetches from LiteLLM at
   runtime (or uses prefetched cache via `--offline` flag).
   Per-entry cost is computed, then summed across the block.
   Sonnet+Opus mixed just works — no special handling.
5. **Library mode.** YES. `ccusage/data-loader` subpath export
   provides `loadSessionBlockData`, `getClaudePaths`,
   `globUsageFiles`, `extractProjectFromPath`, `usageDataSchema`.
   MIT license, Node >=20.19.4 (compatible with Bun). **Least-
   code path for gs-296: import ccusage as a dependency rather
   than reimplementing the reader.** Pulls valibot + tinyglobby
   + xdg-basedir + LiteLLM pricing — acceptable dep weight for
   saving a few hundred lines of JSONL-handling edge cases.

## Remaining open questions

1. **Token-estimate accuracy for pre-cycle gating.** To check
   "would this cycle exceed budget" *before* running the cycle,
   we need an estimate of its cost. Options: (a) upper-bound
   based on `cycle_budget_minutes` × max-tokens-per-minute; (b)
   moving average of historical cycle costs; (c) skip
   pre-estimation, just check post-each-cycle. Option (c) is
   simplest but means the last cycle always overshoots the
   budget by one cycle's worth. Probably acceptable for v1.
2. **How to report the new feature in launch copy.** "Respects
   your subscription limits" is the core message but needs
   sharpening without overclaiming (we don't PREVENT
   oversending, we stop BEFORE cycles if the cap is hit).
3. **Interaction with gs-290 (session-local empty-diff task
   exclusion).** If both features ship, the cycle-gating logic
   sits in a similar spot in session.ts — worth checking they
   compose cleanly rather than fighting for the same hook.
4. **DST / clock-change edge case.** ccusage's block logic is
   purely timestamp-driven with no special handling for
   clock-change events. If the machine's clock jumps backward
   during a session (rare but possible on DST or NTP
   corrections), blocks could split or collapse. For v1,
   accept same behavior as ccusage; revisit only if a user
   reports weirdness.

## Test matrix sketch (for gs-301)

| Scenario | Expected behavior |
|---|---|
| Budget unset | Current behavior preserved (no gating) |
| Budget $5, consumption $3 at cycle N+1 start | Cycle runs |
| Budget $5, consumption $5 at cycle N+1 start | Cycle blocked, `stopReason: "budget"` |
| Budget $5, consumption $6 (overshot) | Logged as budget-exceeded; session ends |
| Advisory mode, budget $5, consumption $6 | Warning logged, cycle runs, session continues |
| Reader throws | Fail-open warning, cycle runs |
| Fleet budget $5 + project budget $2, project consumed $3 | Project cycle blocked (project-level hit) |
| Fleet budget $5 + project budget $2, two projects consumed $2 each | Project cycles blocked (fleet-level hit via aggregation) |
| No budget config, no CLAUDE/OPENROUTER env, Ollama only | Current behavior (Ollama reader returns 0, no meaningful gate) |
| Config validation — both `max_usd` and `max_tokens` set | Error at config load, session aborts |
| Config validation — per-project cap exceeds fleet cap | Error at config load, session aborts |

## References

- `docs/internal/RULE-RELAXATION-2026-04-15.md` — Hard Rule 8
  (BYOK) establishes the economic-exposure principle this
  feature extends
- `docs/integrations/basecamp.md` — established pattern for
  provider-specific integration modules under `src/integrations/`
  (this feature's `src/usage/` follows the same structural pattern)
- `docs/conventions/skills-first.md` — related pattern; usage
  backends aren't skills but the "plug provider-specific code
  behind a shared interface" shape is the same
- ccusage: https://github.com/ryoppippi/ccusage — consumed as
  a library dependency via `ccusage/data-loader` subpath export
  (MIT, Node >=20.19.4). Key internals referenced:
  `src/data-loader.ts` (`getClaudePaths`, `usageDataSchema`),
  `src/_session-blocks.ts` (`DEFAULT_SESSION_DURATION_HOURS = 5`,
  `identifySessionBlocks`), `src/_pricing-fetcher.ts` (LiteLLM
  pricing integration). See §Resolved questions for the specific
  schema + window semantics.
