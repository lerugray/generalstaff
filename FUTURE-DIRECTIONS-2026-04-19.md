# Future Directions — 2026-04-19 (autonomous progression)

**Status:** Forward-looking design intent, captured during the
2026-04-19 morning session. Companion to
`FUTURE-DIRECTIONS-2026-04-15.md` (earlier forward-looking entries).
Not yet scheduled; ships when Ray prioritizes it.

**Prompt for this doc:** Ray observed that the current dispatcher
requires a human to hand-queue each wave of tasks. The vision is
stronger than that — *"[the system is] supposed to be as
autonomous as possible, so long as the user/software sets up a
clear build/live plan the system should be able to function on
its own."* This doc captures what that means mechanically.

## Thesis

**The commander sets the plan once; the system executes it until
completion or decision points.** A well-run staff doesn't ask the
commander to reissue orders after every objective — it follows
the campaign plan, reports progress, and requests new orders only
at decision points the commander flagged in advance.

GeneralStaff's current operating model is closer to *"commander
issues each order separately"*. Every task has to be queued. Every
phase transition is implicit. The system has no structural memory
of *"where this project is going"* — only *"what's in the queue
right now."*

The shift: projects declare a **phased roadmap** upfront. Each
phase has tasks + completion criteria + what comes next. The
dispatcher detects phase completion, surfaces it to the commander,
and — on approval — seeds the next phase's tasks. The commander
only touches the system at phase boundaries, not per task.

## §1 Phased roadmap schema

Each project declares a roadmap at `state/<project>/ROADMAP.yaml`
(or similar — final location TBD). Example shape:

```yaml
project_id: gamr
current_phase: mvp
phases:
  - id: mvp
    goal: "Working end-to-end matchmaking flow, 0 users"
    completion_criteria:
      - all_tasks_done: true
      - custom_check: "bun test passes with >= 80% coverage"
    next_phase: billing

  - id: billing
    goal: "One paid tier (extra match slots), Stripe checkout"
    depends_on: mvp
    tasks_template:
      - title: "Integrate Stripe checkout for monthly subscription"
        priority: 1
      - title: "Add paid-tier feature gate to matchmaking"
        priority: 1
      - title: "Basic billing history page for paid users"
        priority: 2
    completion_criteria:
      - all_tasks_done: true
      - custom_check: "first real test-mode Stripe charge succeeds"
    next_phase: ads

  - id: ads
    goal: "Ad revenue on free tier, privacy-respecting"
    depends_on: billing
    # ... etc
    next_phase: launch

  - id: launch
    goal: "Public launch, paid tier live, ads running"
    depends_on: ads
    completion_criteria:
      - custom_check: "public URL reachable"
      - lifecycle_transition: "dev -> live"
```

### Completion-criteria vocabulary

Start small, expand as needed:

- `all_tasks_done: true` — every task declared for this phase is
  `status: "done"` or `status: "skipped"`
- `custom_check: "<bash one-liner>"` — exit 0 means passed; the
  dispatcher runs this in the project's repo (read-only)
- `launch_gate: "<gate id>"` — a named gate defined in
  project's LAUNCH-PLAN.md that has been marked closed
- `git_tag: "<tag>"` — a tag exists in the project's repo
- `lifecycle_transition: "dev -> live"` — flips the project's
  `projects.yaml` lifecycle flag (per
  UI-VISION-2026-04-19.md §dev-mode-vs-live-mode)

### Task templates vs. literal tasks

Two modes per phase:

- **Literal tasks** (`tasks:`) — exact task rows to enqueue when
  the phase starts. Deterministic; same as today's
  hand-written tasks.json entries.
- **Task templates** (`tasks_template:`) — pattern-ish tasks that
  the commander or an LLM refines at phase-start time. Stays
  human-gated; templates are drafts, not auto-commits.

Start with literal tasks; templates come later if hand-drafting
each phase's task list becomes friction.

## §2 The auto-seed flow

When the dispatcher starts a cycle (or at session start), it runs
a small **phase-progression check** per project:

1. Load ROADMAP.yaml → identify `current_phase`.
2. Evaluate that phase's `completion_criteria`. If all pass:
   a. Mark phase complete in a per-project state file.
   b. Emit a `phase_complete` event to PROGRESS.jsonl.
   c. Load `next_phase` → render its `tasks` (literal or
      template-expanded) into `state/<project>/tasks.json` as
      `pending`.
   d. Update `current_phase`.
3. If criteria not met: no-op, business as usual.

### Commander gate (start here, relax later)

For trust-building, the first implementation **requires human
approval** at each phase transition:

- Dispatcher detects completion → writes a `phase_complete`
  sentinel file in `state/<project>/` + surfaces it in the
  dashboard Attention panel + notifies (Telegram / whatever).
- Commander approves via CLI (`generalstaff phase advance
  <project>`) or dashboard button.
- Only then does auto-seeding run.

Once this runs cleanly for N phase transitions across multiple
projects, opt-in auto-advance is a natural relaxation:
`advance: automatic` in ROADMAP.yaml for phases the commander
pre-authorizes.

## §3 Relationship to existing concepts

This isn't replacing anything; it's adding a layer on top of
what already works.

- **Tasks.json is still the unit of bot work.** Phases are just
  a way to group tasks and declare what's next.
- **Hands-off list still applies.** Phase seeding respects it —
  interactive-only tasks can be templated in phases too.
- **Verification gate still gates every cycle.** Phase completion
  is an additional gate, orthogonal to cycle-level verdicts.
- **LAUNCH-PLAN.md is the human-readable roadmap.** ROADMAP.yaml
  is the machine-readable companion. Keep them in sync; the
  dashboard shows the human view.

## §4 UI integration (Phase 6 v2)

From UI-VISION-2026-04-19.md the dashboard already has:
- **Attention** section — phase-complete events surface here
- **Fleet** cards — show current phase + progress toward next
  gate ("4 of 6 tasks shipped in `billing` phase")
- **Actions** — "Advance to next phase" button gated behind the
  criteria check

This means the UI architecture doesn't need to change — phased
progression slots into the existing sections.

## §5 Why this matters beyond ergonomics

1. **Removes the main friction of long-running autonomy.** The
   2026-04-19 overnight run worked because *I* (interactive
   Claude) reseeded between waves. Without that, the bot would
   have drained its queue in wave 1 and stopped. Phased
   progression removes the reseed driver from the critical path.

2. **Maps to how humans actually plan shipping products.** Nobody
   writes one flat to-do list for a whole product launch. They
   break it into phases (MVP, beta, launch, growth). Encoding
   that in the system means the system matches the user's
   existing mental model.

3. **It's the second half of the BYOK autonomy promise.** Hard
   Rule 8 says the user owns the LLM spend. Phased progression
   means the user also owns the *scope* — they declare it once
   upfront, not by micromanaging the queue. Both together make
   GeneralStaff genuinely autonomous from the user's perspective.

4. **Live-mode transitions become legible.** A phase that flips
   a project from dev mode to live mode has all the ceremony it
   deserves — explicit criteria, explicit approval, explicit
   audit trail. No silent drift.

## §6 What this is NOT

- Not a project management tool. We don't schedule tasks on a
  calendar, assign owners, or track velocity.
- Not a replacement for judgment. Commander still writes the
  roadmap (taste work, Hard Rule 1).
- Not Jira / Linear / Notion integration. Roadmap is plain YAML
  in the project's state directory. User edits it like any other
  config file.
- Not infallible. Completion criteria can lie (a passing test
  suite can still miss a bug). Verification gate remains the
  catch-all.

## §7 Open questions

1. **Where does ROADMAP.yaml live?** `state/<project>/` inside
   GeneralStaff (dispatcher-side, travels with the dispatcher
   repo) or inside the managed project's own repo (project-side,
   travels with the code)? Trade-offs both ways; start with
   dispatcher-side to stay consistent with `MISSION.md` and
   `tasks.json` locations.

2. **How does the dashboard render phase progress?** Progress bar,
   task checklist, both? UI-VISION-2026-04-19.md's Fleet card
   has room; resolve with a mockup pass once the YAML schema
   settles.

3. **What's the minimum viable ROADMAP.yaml?** A single phase
   with literal tasks? Two phases with `next_phase` wiring? The
   first real user should be able to write one in under 5
   minutes without reading a manual.

4. **How does phase transition interact with the launch-gates
   checklist in LAUNCH-PLAN.md?** Some gates are phase-transition
   triggers (e.g., "v0.1.0 tag cut" → fires a phase transition).
   Unify the vocabularies, or let them coexist? Start with
   coexist; unify if duplication becomes painful.

5. **Multi-phase templates?** A generic "subscription SaaS" or
   "static marketing site" roadmap that projects can adopt as a
   starting point. Cuts first-time-setup friction. Deferred —
   nice but not v1.

6. **Rollback.** What if a phase transitions, tasks are seeded,
   then the commander decides phase N wasn't actually complete?
   Need a `phase rollback` or `phase undo` command. Deferred —
   fix once it happens the first time.

## §8 First cut scope (when we ship this)

Minimum viable v1:

- Parse `state/<project>/ROADMAP.yaml` at session start
- Evaluate `all_tasks_done` + `custom_check` criteria only
- Commander-gated approval (CLI or dashboard button)
- Emit `phase_complete` PROGRESS.jsonl event
- Seed literal tasks (no template expansion)
- Surface in dashboard Attention section

Explicit non-goals for v1: templates, auto-advance, multi-phase
rollback, LAUNCH-PLAN gate unification, project-side roadmap
storage.

## §9 Gamr as first test case

Ray's 2026-04-19 observation: gamr looks more shippable than
originally framed, and would be a useful first live-project test
case for both the dispatcher and phased progression.

gamr's draft launch plan is captured at
`../gamr/LAUNCH-PLAN.md` (written alongside this doc). The
initial phases there — MVP, billing, ads, launch — are the
first real ROADMAP.yaml candidate whenever this feature ships.

---

**Captured:** 2026-04-19 morning session
**Related:** UI-VISION-2026-04-19.md (dev/live mode distinction),
`CLAUDE.md` §Test-project constraints (gamr framing shift on
same date), `../gamr/LAUNCH-PLAN.md` (gamr phased plan)
**Owner:** Ray (taste call on schema, scope, when to prioritize)
