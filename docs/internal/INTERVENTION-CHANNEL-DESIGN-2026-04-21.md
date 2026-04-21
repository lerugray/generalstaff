# Intervention Channel — Design Sketch (2026-04-21)

For gs-293. A real-time operator-in-loop mechanism: when a bot cycle
hits ambiguity it currently would abandon (proposal to
`bot-proposals/`) or guess through, instead pause the cycle, surface
a question to the operator via the dashboard, accept a text response,
and resume the cycle with that context.

This is sketch territory, not full spec. The goal here is to
structure the cross-cutting change enough that Ray can decide whether
to greenlight a Phase 6.5+ implementation pass and so that future
sessions aren't re-deriving the shape from scratch.

## Motivation

### The Hammerstein ceiling is real

GeneralStaff's launch framing (see `docs/internal/UI-VISION-2026-04-19.md`
and `src/prompts/reviewer.ts`) acknowledges a ceiling: bot autonomy
works until it hits a judgment call that genuinely requires human
taste — API shape, product copy, which of two equivalent abstractions
to pick, how to resolve a legitimate ambiguity in a spec. Today, GS
has two responses at that ceiling:

1. **Abandon to `bot-proposals/`** — cycle fails safely, Ray sees the
   proposal later, arbitrates, re-queues with clarification. Fine for
   low-urgency decisions. Slow for high-urgency ones.
2. **Push through with the bot's best guess** — cycle ships code Ray
   has to review and potentially roll back. Fast but
   judgment-dependent.

Neither option acknowledges the natural human workflow: "let me just
tell you what I want." The intervention channel adds that as option 3:
**pause, ask, answer, resume.**

### Polsia differentiator

The corrected framing from the usage-budget doc still applies: Polsia
runs on separate credits; GS runs on the user's own subscription. The
intervention channel deepens that differentiation on a different
axis — **operator presence**. Polsia is designed around
fire-and-forget autonomy. GS is designed around bot-with-human-in-reach,
and the intervention channel makes the reach-back concrete rather
than implicit.

Launch copy angle: "When the bot hits taste, it asks. You answer.
Work continues."

## Protocol — file-based IPC

Three new artifacts, all under the active session's state directory
(existing pattern — sessions already write `STATE.json`, `PROGRESS.jsonl`,
`cycles/*.md`):

### `.bot-waiting-input`

Written by the engineer process when it decides it needs human
judgment. Schema:

```json
{
  "intervention_id": "<uuid>",
  "created_at": "2026-04-21T23:45:00Z",
  "session_id": "<session_id>",
  "project_id": "<project_id>",
  "task_id": "<task_id>",
  "cycle_id": "<cycle_id>",
  "question": "Short operator-facing prompt (~1-2 sentences)",
  "context": "Optional longer context (~paragraph) — what the bot already tried, what ambiguity it's stuck on",
  "options": null | ["option_a", "option_b", ...],
  "default_on_timeout": "abandon | proceed_with_guess | <one of options>"
}
```

Free-text `question` is always required. `options` is optional — if
present, the UI renders as multiple-choice radio buttons; if absent,
as a freeform textarea.

### `.operator-response`

Written by the server when the operator submits a response via the
dashboard. Schema:

```json
{
  "intervention_id": "<uuid>",
  "responded_at": "2026-04-21T23:47:12Z",
  "operator": "<email or identifier from server context>",
  "response_kind": "selected_option | freeform | abandon_cycle",
  "response": "operator's text OR the selected option string OR null if abandon"
}
```

Engineer polls (or `fs.watch`) for `.operator-response` after writing
`.bot-waiting-input`. Once it reads + validates the response, it
deletes both files (or moves them to `cycles/<cycle_id>/interventions/`
for audit retention) and resumes with the response fed back into the
prompt context.

### `PROGRESS.jsonl` — two new event types

Emitted by the engineer + session loop for dashboard + audit:

```json
{"type": "intervention_request", "ts": "...", "intervention_id": "...", "session_id": "...", "question": "..."}
{"type": "intervention_response", "ts": "...", "intervention_id": "...", "responded_at": "...", "response_kind": "...", "elapsed_ms": 127000}
```

Having both in PROGRESS.jsonl means the existing SSE tail stream
(`/tail/:sessionId/stream`, see `src/server/routes/tail.ts`)
naturally carries intervention signals to the dashboard without
a new transport.

## Architecture — three sides

### Bot side (engineer prompt + process)

Two prompt changes in `src/prompts/`:

1. **Teach the bot when to ask.** Add a discipline clause: "If you hit
   a genuine judgment call that affects the shape of what ships —
   API ergonomics, product copy voice, which of two equally-valid
   patterns to use, an ambiguity in the task description you can't
   resolve from context — write `.bot-waiting-input` with a concrete
   question. DO NOT ask for factual questions you can answer from the
   codebase; DO NOT ask for permission on routine work; DO NOT ask
   every cycle." The "don't abuse the channel" framing matters —
   cheap asks would degrade the operator's willingness to use GS.
2. **Teach the bot how to read the response.** When `.operator-response`
   appears, integrate `response.response` into ongoing work and
   continue. No re-planning from scratch — the existing work-in-progress
   context is still live.

On the process side, the engineer subprocess (`src/engineer.ts`
wraps `resolveEngineerCommand`) needs to know that the `.bot-waiting-input`
file is a special artifact, not source output. That's already partly
true for `bot-proposals/` — the intervention channel extends the
"bot-controlled sideband artifact" concept.

### Server side (detection + routing)

Changes in `src/server.ts` + `src/server/routes/`:

1. **Detector.** Either `fs.watch` on each active session's state
   directory for `.bot-waiting-input` creation, or a debounced poll
   (e.g. every 2s) in the existing session-status loop. `fs.watch`
   is nominally correct but Node's `fs.watch` is famously unreliable
   on Windows + network filesystems; GS runs on Ray's Windows
   work-PC, so **default to 2s poll** and upgrade later if latency
   becomes annoying.
2. **Submit endpoint.** New route `POST /intervention/:sessionId/:interventionId`
   accepts `{response_kind, response}` form-encoded, validates, writes
   `.operator-response`, returns 200. Existing CSRF posture (see
   `src/server.ts:83` CSP comment) applies.
3. **SSE push.** When the detector sees a new `.bot-waiting-input`,
   it writes `intervention_request` to PROGRESS.jsonl and the
   existing tail-SSE path naturally pushes it to subscribed clients.

### UI side (dashboard panel)

Changes in `src/server/static/` + `src/server/templates/`:

1. **Pending-interventions panel.** New component on the session
   dashboard that listens for `intervention_request` events on the
   existing SSE stream. Renders a card per pending intervention:
   question text, optional context collapsible, input (textarea or
   radio-buttons depending on `options`), submit button, abandon
   button.
2. **Submit flow.** POST to the new intervention endpoint; on 200,
   remove the card locally (SSE will push `intervention_response`
   shortly confirming). On error, surface inline.
3. **Stale-intervention handling.** If a card has been waiting >1min
   without operator action, visually mark it urgent. If the engineer
   times out and writes `intervention_response` with the default
   fallback, SSE push removes the card with a "timed out → <default
   action>" toast.

### Session loop side

Changes in `src/session.ts`:

1. **Cycle-budget accounting.** The cycle's wall-clock is paused
   while waiting for operator response — otherwise a question that
   takes the operator 5 minutes to answer would blow through
   `cycle_budget_minutes`. New field in `CycleResult`:
   `intervention_wait_ms` — total time spent waiting for operator,
   subtracted from wall-clock when computing cycle-budget
   consumption.
2. **Stop-reason plumbing.** If operator responds with
   `response_kind: "abandon_cycle"`, the cycle terminates with
   `stopReason: "operator_abandoned"` — distinct from
   `stopReason: "budget"` or the existing abandon reasons. Reporting
   (`src/session_report.ts`) surfaces these distinctly.

## Fail-mode semantics

The feature can fail in several ways. Explicit default behavior per
mode:

| Failure mode | Default response |
|---|---|
| Operator never responds (timeout expires) | Use `.bot-waiting-input.default_on_timeout`. If that's `abandon`, cycle abandons to bot-proposals. If `proceed_with_guess`, bot picks its own best guess and notes the self-call in PROGRESS.jsonl. If a specific option, use it. |
| Server process not running when bot writes `.bot-waiting-input` | Bot polls until server returns (hard timeout at e.g. 2× normal). If still no server, fall back to `default_on_timeout` path. |
| Bot writes malformed `.bot-waiting-input` (bad JSON, missing fields) | Server ignores, logs warning to PROGRESS.jsonl; engineer treats as "no interest from operator" and falls back to `default_on_timeout` behavior. |
| Operator submits malformed response (e.g. selects option not in options list) | Server rejects (400), UI shows error, engineer keeps waiting. |
| PROGRESS.jsonl write fails (disk full, permissions) | Loud warning to stderr, cycle continues as if intervention weren't attempted. |

**Principle:** intervention should degrade to existing behavior when
anything fails. The feature is additive; nothing existing should break
when intervention infrastructure is unavailable.

## Config surface

New fields in `DispatcherConfig` + optional per-project override in
`ProjectConfig` (matches the pattern established in
`USAGE-BUDGET-DESIGN-2026-04-21.md` §Config surface):

```yaml
dispatcher:
  intervention:
    enabled: true                      # feature master switch
    timeout_seconds: 600               # default 10min operator-response timeout
    on_timeout: "abandon"              # abandon | proceed_with_guess
    poll_interval_ms: 2000             # server-side detector cadence
    pause_cycle_budget: true           # subtract wait time from cycle budget

projects:
  - id: "some-project"
    intervention:
      enabled: false                   # per-project disable
```

**Default: disabled.** This is a behavior change to session flow;
operators opt in explicitly. Once turned on per-fleet, per-project
disable is rare but available.

## Sub-task breakdown (future tasks.json entries)

The feature is cross-cutting — ~2-3 weeks of focused work. Six
sub-tasks, all `interactive_only` because they touch `src/prompts/`,
`src/server/`, and `src/session.ts` (all hands_off-adjacent):

**gs-311 — File-based IPC schema + engineer prompt update (interactive)**
- `.bot-waiting-input` + `.operator-response` schemas documented
- Prompt guidance for when to write + how to read the response
- Touches: `src/prompts/` (hands_off)
- ~150-200 LOC prompt + ~50 LOC schema/validator

**gs-312 — Server-side detector + submit endpoint (interactive)**
- `fs.watch` or 2s poll for `.bot-waiting-input`
- POST route with CSRF validation
- PROGRESS.jsonl event emission
- Touches: `src/server.ts` or `src/server/routes/` (hands_off-adjacent)
- ~200-300 LOC + tests

**gs-313 — Dashboard panel + SSE integration (interactive)**
- New UI component in `src/server/static/` + template update
- SSE client-side handling for `intervention_request` / `intervention_response`
- Submit flow + stale marker
- Touches: `src/server/static/`, `src/server/templates/` (hands_off)
- ~300-400 LOC

**gs-314 — Session loop integration — wait-pause + stop-reason (interactive)**
- Cycle-budget pause during operator wait
- New `stopReason: "operator_abandoned"`
- Reporting surface in `src/session_report.ts`
- Touches: `src/session.ts` (dispatcher-adjacent)
- ~150-250 LOC

**gs-315 — Config surface + validation (bot-pickable)**
- `dispatcher.intervention` fields in `DispatcherConfig`
- `intervention` override in `ProjectConfig`
- Validation (e.g. `timeout_seconds > 0`, `poll_interval_ms` sane)
- `expected_touches: ["src/types.ts", "src/projects.ts", "tests/projects.test.ts"]`
- ~150-200 LOC — mirrors `gs-297` shape

**gs-316 — Integration test matrix + end-to-end fixture (interactive)**
- Happy path: bot asks → operator answers → cycle continues
- Timeout path: bot asks → no operator → default fallback
- Server-down path: bot asks → server unreachable → default fallback
- Abandon path: operator abandons → session stops with reason
- Concurrency: two concurrent sessions, both have pending interventions
- Touches: test infrastructure + possibly fixtures that mimic engineer behavior
- ~400-500 LOC

## Open questions

1. **Abuse prevention.** If the prompt guidance doesn't calibrate
   right, bot might ask about routine decisions. Countermeasures:
   (a) per-cycle ask-budget (hard cap of N interventions per cycle,
   default 1); (b) reviewer step gates asks (bot's "I should ask"
   decision gets reviewer approval before `.bot-waiting-input` is
   actually written); (c) observe + tune prompt after first
   week of real use. Option (a) is easy + safe for v1; (c) is
   probably the real long-term answer.
2. **Multiple concurrent interventions across sessions.** Parallel-
   mode (Phase 4+) could have 3 sessions each with pending asks.
   Dashboard needs to render a queue, not just the most-recent.
   Shape: card-list sorted by age, most-urgent at top.
3. **Operator not at the dashboard.** If Ray is away from the
   machine, cycles pile up waiting. Timeout is the safety valve.
   Should we also push notify (e.g. email, Slack, phone)? Scope
   creep for v1 — leave as a future task. For v1, dashboard-only.
4. **Question persistence for post-hoc review.** Should resolved
   interventions appear in session summary/digest? Yes — extends
   the existing digest with an "Interventions" section. Gets the
   operator's engagement visible in post-session review. Handle in
   `gs-314` alongside reporting.
5. **Does the bot's own fleet-messages channel (`src/fleet_messages.ts`)
   compose with this?** The fleet-messages channel is for bot ↔ bot
   coordination across projects; intervention is bot ↔ operator.
   Different direction. Worth keeping separate; don't generalize
   both into one channel.
6. **Observability under heavy use.** If a single session generates
   20 interventions, PROGRESS.jsonl grows fast + UI rendering gets
   heavy. Likely fine for v1 scale; flag if real use proves it a
   problem.

## Test matrix sketch (for gs-316)

| Scenario | Expected behavior |
|---|---|
| Feature disabled, bot "tries" to write input file | File exists but detector ignores; engineer hits timeout; default fallback |
| Feature enabled, happy path | Input written → SSE push → operator submits → engineer resumes → cycle completes normally |
| Operator submits with options list, selection valid | Engineer resumes with selected option |
| Operator submits with options list, selection invalid | Server rejects 400; engineer keeps waiting |
| Timeout with `on_timeout: abandon` | Engineer falls back; cycle abandons to bot-proposals; `stopReason: "operator_abandoned"` equivalent |
| Timeout with `on_timeout: proceed_with_guess` | Engineer resumes with best guess; intervention_response logged with `response_kind: "timeout_guess"` |
| Server process down when bot writes input | Engineer polls, eventually falls back |
| Cycle-budget accounting | Wait time excluded from cycle_budget_minutes |
| Two parallel sessions, both with pending interventions | UI shows both; operator can respond in any order |
| Malformed input file | Server logs warning, detector skips; engineer falls back |
| Abandon-cycle response | `stopReason: "operator_abandoned"`; session-report distinguishes |

## Implementation order

Suggested order for a focused multi-day session:

1. **gs-315 (config schema) first** — no dependencies; unblocks everything.
2. **gs-311 (IPC + prompt)** — pure additive change; engineer can write files and poll even before server is ready, gracefully timing out.
3. **gs-312 (server detector + endpoint)** — now files have somewhere to go.
4. **gs-313 (UI panel)** — now operator has a way to respond.
5. **gs-314 (session loop)** — wait-pause + reporting.
6. **gs-316 (test matrix)** — harden the end-to-end path.

The prompt/engineer side (gs-311) lands before the server side (gs-312)
so the degrade-gracefully fallback is tested for real: engineer writes
file, no server running, timeout, fallback path hits naturally.

## Phase positioning

This is a **Phase 6.5+ feature**, per gs-293's original framing. The
public GS repo is currently in Phase 5 territory (Basecamp integration,
session-report CLI, usage-budget design). Intervention channel is
larger than a Phase boundary-feature — it's a whole dimension of
operator-interaction that deserves its own Phase narrative.

**Strong recommendation: ship usage-budget (gs-295..gs-301) first.**
Usage-budget is a defensive feature (prevents bill shock), finishable
in ~1-2 weeks, launch-meaningful. Intervention is an ambitious feature
(new UI surface, new IPC, cross-cutting), finishable in ~3 weeks,
differentiating. Sequencing: usage-budget → launch → intervention as
a v1.x differentiation lever once the ecosystem has a reason to care.

## References

- `docs/internal/USAGE-BUDGET-DESIGN-2026-04-21.md` — sibling design
  doc with the same structural template (motivation / architecture /
  fail-modes / sub-tasks / open questions / tests / refs)
- `docs/internal/UI-VISION-2026-04-19.md` — the Hammerstein-ceiling
  framing + operator-presence narrative this feature extends
- `docs/internal/FUTURE-DIRECTIONS-2026-04-19.md` — intervention
  channel is on the Phase 6+ idea list
- `src/prompts/reviewer.ts` — existing reviewer prompt; intervention
  prompt guidance lands adjacent to this
- `src/server/routes/tail.ts` — existing PROGRESS.jsonl SSE tail
  endpoint; intervention events flow through the same channel
- `src/server.ts:83` (CSP) + `src/server.ts:274` (route table) —
  server anchor points for new routes
- gs-293 in `state/generalstaff/tasks.json` — the parent task this
  doc expands
