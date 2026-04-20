# RULE-RELAXATION-2026-04-20-catalogdna — catalogdna GS-eligibility

**Effective date:** 2026-04-20
**Supersedes:** The "catalogdna is off-limits as a GeneralStaff test
target" bullet in `CLAUDE.md` §Test-project constraints (which dates
to the pre-pivot paranoid phase when GS hadn't been production-tested
on anything).
**Companion file** (same-day, different concern):
`docs/internal/RULE-RELAXATION-2026-04-20.md` is the Bookfinder
General creative-work opt-in. These two relaxations are independent.

---

## What this documents

Ray relaxed the blanket "do not register catalogdna" constraint on
2026-04-20 afternoon with this exact reasoning:

> "the hard constraint on catalog DNA in the claude.MD can be
> relaxed, thats from when I was more paranoid about it but I trust
> the work that GS has been doing and organizationally it will help
> catalogDNA regardless"

Two things changed between the original constraint being written
and today:

1. **GS has shipped verification discipline on other projects.** Five
   days of production use — generalstaff dogfooding, gamr,
   raybrain Phase 1, bookfinder-general bf-001..005 — have
   demonstrated that the verification-gate + hands_off + reviewer
   combination does what the off-limits rule was indirectly
   protecting against: unwanted bot edits to sensitive files.
2. **The framing matured.** The original constraint assumed GS
   registration meant "bot cycles run against this project
   autonomously." Today's understanding (articulated 2026-04-20
   afternoon in conversation) is that GS supports at least two use
   modes, and the catalogdna registration will use the second:

---

## Use modes recognized by this relaxation

**Mode A — bot-primary.** Standard generalstaff/gamr/bookfinder
pattern. Bot cycles run autonomously; engineer_command does the
work; verification gate + reviewer adjudicate; hands_off blocks
sensitive paths. This is what the original catalogdna constraint
was protecting against.

**Mode B — interactive-primary with GS as discipline layer.** The
dispatcher may never actually run bot cycles (or run them only on
a very narrow bot-safe slice). The project benefits from
GeneralStaff's *structural* surface: `state/<id>/tasks.json` as the
canonical to-do list, `state/<id>/MISSION.md` as the scope boundary,
`hands_off` as the enforced no-touch list, `PROGRESS.jsonl` as the
audit trail for whatever work (interactive or bot) lands. The
discipline applies; automation is opt-in per task via
`interactive_only: false`.

catalogdna's registration will default to **Mode B**. Bot cycles
stay off unless Ray explicitly flips a task to bot-pickable.

---

## What's explicitly unchanged

- **Ray's taste authority over vault-finalization and any
  user-facing content.** The original concern about "stuff that
  needs Ray's creative eye, such as finalizing the vaults for
  users" is still valid. catalogdna's registration will have
  `creative_work_allowed: false` (default) and a generous
  hands_off list covering vault-finalization paths, onboarding
  copy, user-facing templates, and Ray's personal editorial
  surface.
- **Hard Rule #1 and its narrow creative-work carve-out.** The
  carve-out (`RULE-RELAXATION-2026-04-20.md` for bookfinder-general)
  is project-specific. catalogdna does NOT opt in at relaxation
  time.
- **Hard Rule #5 (mandatory hands_off lists).** catalogdna's
  registration must include a non-empty hands_off list before the
  project is considered registered.
- **The broader "confirm before suggesting" guidance** for any Ray
  project with real users. This relaxation is for catalogdna
  specifically, not a blanket policy change. Future Ray projects
  with real users should still trigger a conversation before GS
  registration — the bar is lower now (we can register them) but
  it's not absent.

---

## How the registration should happen

Registration is a ceremony (per `CLAUDE.md` §"Adding a project is
a ceremony, not a casual edit"), doubly so for the first
Mode-B-primary project. Steps:

1. **Scoping audit session** (interactive, before registration).
   Read catalogdna's CLAUDE.md + CLAUDE-AUTONOMOUS.md +
   `bot_tasks.md` + recent commits. Understand what's live, what's
   half-done, what's sensitive. The audit produces:
   - A draft `state/catalogdna/MISSION.md` scoped to what GS should
     care about (explicitly names the vault-finalization /
     user-facing surfaces as out-of-scope).
   - A draft `state/catalogdna/tasks.json` that breaks down current
     work into a prioritized list, every task marked
     `interactive_only: true` by default until the audit has a
     reason to opt specific tasks to bot-pickable.
   - A draft `projects.yaml` entry with a generous hands_off
     (err on the side of restrictive — loosen over time, not
     tighten).
2. **Ray review** of the audit output before anything lands in
   `projects.yaml`.
3. **Registration** — create the `state/catalogdna/` directory in
   GS, land the projects.yaml entry.
4. **First session** may be pure Mode B (bot sees nothing pickable,
   session ends cleanly). That's a success signal — the dispatcher
   and hands_off are working, and the audit log starts recording
   interactive-edit provenance too if Ray uses the CLI to mark
   tasks done.

The registration is *not* executed by this doc. This doc just
removes the blanket prohibition.

---

## Exit criteria — when to re-apply the constraint

The relaxation is revocable. Specific triggers:

1. **The bot ships an edit to a hands_off file via any channel.**
   Shouldn't happen — verification gate + hands_off are supposed
   to prevent this — but if it does, the first occurrence pauses
   bot cycles pending audit, and two occurrences re-applies the
   full off-limits constraint.
2. **Interactive-primary mode produces task-discovery slop.** If GS's
   task-structuring discipline generates tasks that waste Ray's
   time (too granular, wrong scope, priority-inverted, etc.), roll
   back to ad-hoc interactive work on catalogdna.
3. **catalogdna gains a second engineer with their own workflow
   preferences.** If another contributor joins, GS's workflow may
   not fit their style, and forcing it would be worse than no
   structure. Revisit.
4. **Any signal that GS registration is reducing Ray's catalogdna
   velocity.** Measured against the baseline of just-interactive
   work at catalogdna.

Reverting is a few-line edit: delete the catalogdna entry from
`projects.yaml`, leave `state/catalogdna/` for the audit log (don't
lose the history), restore the CLAUDE.md §Test-project constraints
bullet to its pre-relaxation text, write a brief `POST-MORTEM` in
this file explaining what failed.

---

## Decision attribution

Decided 2026-04-20 afternoon by Ray in conversation with Claude
(Opus 4.7, interactive session). Trigger: Ray raised registering
Devforge + catalogDNA + Retrogaze as new GS-managed projects;
Claude flagged the existing catalogdna off-limits constraint; Ray
authorized the relaxation with the rationale quoted at the top of
this doc.

Protocol followed:
1. Constraint identified in CLAUDE.md by Claude.
2. Relaxation authorized by Ray.
3. This doc drafted as the required ceremony per CLAUDE.md
   §"Hard rules": *"existing rules cannot be relaxed without an
   explicit RULE-RELAXATION-<date>.md log file documenting why."*
4. CLAUDE.md §Test-project constraints updated to replace the
   "off-limits" bullet with a reference to this doc + the Mode-B
   framing.
5. Actual catalogdna registration deferred to a dedicated scoping
   session (step 1 above).
