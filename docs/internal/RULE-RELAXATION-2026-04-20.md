# RULE-RELAXATION-2026-04-20 — Bookfinder General creative-work opt-in

**Effective date:** 2026-04-20
**Scope:** One project only — `bookfinder-general` (pending
registration). Does **not** change the global default. All other
projects (generalstaff dogfood, gamr, raybrain, catalogdna,
retrogaze, sandkasten, future) keep Hard Rule #1's default
behavior: no creative-work delegation.

---

## What this documents

This is not strictly a *relaxation* of Hard Rule #1. Re-read the
rule verbatim:

> **Hard Rule #1.** No creative work delegation **by default**.
> Bots get correctness work; users keep taste work. Creative
> agents (marketing/growth/support) are **opt-in plugins with
> explicit warnings.**

The rule already permits per-project creative-work opt-in. What
this doc captures is:

1. The decision to enable that opt-in for Bookfinder General
   specifically.
2. The guardrails we want around any project that opts in.
3. The exit criteria — how we'd know to pull the opt-in.
4. The implementation mechanism (the code change that makes the
   opt-in surfaceable in `projects.yaml`).

Filing it under the rule-relaxation naming convention because
`docs/internal/RULE-RELAXATION-<date>.md` is how CLAUDE.md tells
future sessions to check what's been tuned on the rules. Future
sessions reading the hard-rules list should see this file in the
`docs/internal/` listing and open it before assuming the old
strict reading of Hard Rule #1.

---

## Why Bookfinder General

**Bookfinder General** is Ray's open-source tool that helps find,
analyze, and summarize books found on Anna's Archive. As of the
2026-04-20 decision it has 1 GitHub star — a real user, but low
commercial stakes, low brand-risk exposure, and an audience that
is already AI-native (the tool *is* an AI tool).

The factors that make this project a legitimate candidate for
creative-work opt-in:

1. **Low stakes.** No paying customers, no brand narrative tied
   to boutique-human aesthetic, no partners or collaborators
   whose reputations are on the line. If the bot drafts a bad
   README section, the blast radius is one README section.
2. **AI-native audience.** Users of an AI summarization tool
   don't pattern-match AI-generated copy as a betrayal of authorial
   intent the way readers of a literary newsletter would. The
   "AI wrote this" signal is consistent with the product.
3. **Voice is bootstrappable from other projects.** Ray's PIH
   (Project-in-Harbor — ask Ray if you find this reference and
   don't know which project) manuals and other writing are
   available as voice-reference corpora. Bot output, when
   seeded with those references, should be closer to Ray's
   voice than the LLM mode-of-training-distribution default.
4. **Human-in-the-loop stays mandatory (guardrail 2 below).**
   Bot never publishes directly — it drafts, Ray edits, Ray
   publishes.
5. **Low regulatory / legal risk from AI-generated marketing.**
   Anna's Archive adjacency is already in gray-legal territory,
   and no major platform will deplatform a niche GitHub tool
   over "your README sounds AI-generated."

**Counterarguments considered and rejected:**

- *"Slippery slope — once one project opts in, pressure to
  enable more grows."* Partially fair, but the opt-in is per
  project and requires this doc to land. The ceremony itself is
  the slope-prevention mechanism.
- *"The gamr-030 benchmark showed Qwen3 Coder gaming a verdict
  when it couldn't figure out the scope — that's exactly the
  shape creative-work slop will take, and we have no reviewer
  gate for creative work."* This is the serious objection and
  is why guardrails 2, 3, and 4 below are non-negotiable.

---

## Guardrails

Any project with `creative_work_allowed: true` in its
`projects.yaml` entry MUST obey these:

### 1. The field is per-project and off by default

`creative_work_allowed` is a new optional `ProjectConfig` field
defaulting to `false`. Absent the field, or explicitly set to
`false`, every cycle behaves exactly as it does today (Hard
Rule #1 default). Other projects are not affected.

### 2. Human-in-the-loop on every creative deliverable

The bot **drafts**; Ray **edits and publishes**. Creative-tagged
outputs land in one of:
- a `drafts/` subdirectory inside the managed project
- a dedicated `bot/creative-drafts` branch separate from `bot/work`

The bot never pushes to `main`/`master` for a creative-tagged
task. The bot never opens a PR on Ray's behalf for creative
work. The bot never posts to any external surface (Twitter, HN,
Reddit, the project's own site) autonomously — those remain
manual actions Ray takes after reviewing drafts.

The dispatcher enforces this by routing creative-tagged tasks
to a distinct branch and/or output folder, configured per
project in `projects.yaml`.

### 3. Explicit warning at launch and in the audit log

When a session starts a creative-tagged cycle, the dispatcher
prints a loud warning:

```
[WARN] Starting CREATIVE_WORK cycle for <project>:<taskId>.
       Creative work bypasses Hard Rule #1 via project opt-in.
       Bot will draft; human review is MANDATORY before publication.
       See docs/internal/RULE-RELAXATION-2026-04-20.md.
```

`PROGRESS.jsonl` records a distinct event type for creative
cycles so future audits can grep them out cleanly.

### 4. Voice-reference bootstrap

The ProjectConfig also adds an optional `voice_reference_paths`
string[] field. For creative-tagged tasks, the engineer prompt
prepends a "read these files first to calibrate voice" section
pointing at the listed paths. Bookfinder's registration will
seed this with Ray's PIH manuals (or equivalent voice corpus).

**Expected voice-source expansion (2026-04-20 addendum):**
- **Now:** PIH manuals. Ray authored these directly and they
  capture his working voice on technical/operational writing.
- **Shared resource:** raybrain also has access to the PIH
  manual corpus, so there's cross-project precedent for using
  them as a voice reference. If raybrain ever owns a canonical
  "Ray's voice" skill or prompt library, Bookfinder should
  consume from that rather than maintain a local copy — one
  source of truth beats a fan-out that drifts.
- **Future:** Ray's Facebook export, once raybrain ingests and
  processes it, becomes a much richer voice corpus (years of
  informal first-person writing in his actual idiom). Any further
  writing Ray produces (blog posts, PIH v2, game-design docs,
  etc.) is similarly additive.
- **Composition rule:** `voice_reference_paths` is a list
  precisely so it can grow without schema churn. Order matters —
  the engineer reads them top-to-bottom, so highest-signal source
  first.

### 5. No delegated algorithm choices or taste calls

Even within creative work, the bot is not allowed to make
delegated taste calls. Tasks must specify:
- the format/genre/platform (README section vs. HN post vs.
  launch tweet)
- the target audience
- the specific thesis or message Ray wants communicated
- the desired length / tone band (not just "write something
  compelling")

A task that says "figure out how to market this project" is
**still out of scope**. A task that says "draft a 150-word
README section explaining why Bookfinder exists, in the voice
of my PIH manuals, audience: open-source developers browsing
GitHub" is in scope.

Specifying the *brief* stays with Ray. The bot executes briefs,
never generates them.

---

## Exit criteria — when to pull the opt-in

The opt-in is revocable. Specific triggers for reverting
Bookfinder to creative-work-off:

1. **The bot ships drafts Ray can't usably edit.** If 3+
   consecutive creative-tagged cycles produce output so far
   from usable that editing takes longer than writing from
   scratch, the opt-in is doing net-negative work. Revert.
2. **The bot makes un-reviewed public posts.** Any occurrence
   means guardrail 2 failed; revert immediately and audit the
   failure mode.
3. **Bookfinder gains real commercial stakes.** If the project
   ever takes paying users, a sponsor, a platform deal, etc.,
   the "low stakes" premise expires. Revert to default Hard
   Rule #1 and revisit.
4. **A pattern of gamed verdicts emerges on creative tasks.**
   Similar to gamr-030 — if the bot starts marking tasks done
   without actually drafting real content, revert.

Reverting is a one-line edit in `projects.yaml` (set
`creative_work_allowed: false` or delete the field). No code
rollback needed.

---

## Implementation — what needs to land

This is the code work that makes the opt-in mechanically
available. **Not done by this doc** — this doc is the policy;
implementation is a separate task (gs-278, queued for a future
session).

### ProjectConfig additions

```typescript
export interface ProjectConfig {
  // ... existing fields ...
  creative_work_allowed?: boolean;           // default: false
  creative_work_branch?: string;             // default: "bot/creative-drafts"
  creative_work_drafts_dir?: string;         // default: "drafts/"
  voice_reference_paths?: string[];          // default: []
}
```

### Dispatcher behavior

- If a picked task has `creative: true` (new optional field on
  `GreenfieldTask`) AND the project has `creative_work_allowed:
  true`, the cycle proceeds but with the CREATIVE_WORK warning
  and branch override.
- If a picked task has `creative: true` but the project does
  NOT have `creative_work_allowed: true`, the cycle is
  immediately skipped with reason
  `creative_work_not_allowed_for_project`. (Do not silently
  fall back to default; explicit fail is the correct behavior.)
- Engineer prompt for creative tasks prepends a voice-reference
  section pointing the engineer to `voice_reference_paths`
  before drafting.
- Reviewer gate is SKIPPED for creative-tagged tasks — the
  scope-drift + hands-off gates don't translate cleanly to
  prose, and the human-in-the-loop is the review mechanism.
  Verification command runs normally (e.g. markdown lint,
  spellcheck).

### tasks.json shape

```json
{
  "id": "bookfinder-010",
  "title": "Draft a 150-word README section...",
  "status": "pending",
  "priority": 1,
  "creative": true,
  "voice_reference_override": ["docs/voice/pih-manual-1.md"]
}
```

### Tests

- ProjectConfig parsing accepts / rejects the new fields.
- Task picker skips creative tasks on non-opted-in projects
  with the correct reason.
- Dispatcher routes creative-tagged cycles to the creative
  branch.
- Warning is emitted at launch.
- Audit log event uses the distinct creative event type.

### Hands-off integration

Creative-tagged cycles must still respect hands_off — the bot
can't sneak into `src/safety.ts` by marking the task creative.
Hands-off is an orthogonal protection; creative-work opt-in
relaxes Rule #1 only, not Rule #5.

---

## What this DOES NOT change

- All other Hard Rules (2 through 10) remain in force
  unchanged for Bookfinder and every other project.
- Default behavior for every other registered project remains
  Hard Rule #1 strict — no creative-work delegation.
- The Hammerstein framing is unchanged: bots handle execution,
  commander keeps taste. Creative-work opt-in is a *narrow
  delegation of draft execution* with taste review still
  sitting with Ray.
- The dispatcher's verification gate remains load-bearing for
  correctness work. Nothing about this opt-in weakens the gate
  for non-creative cycles on any project.

---

## Decision attribution

Decided 2026-04-20 by Ray in consultation with Claude (Opus
4.7, interactive session). Trigger: Ray raised registering
Bookfinder General as a managed project, asked whether GS could
"improve it / come up with a plan for it to find more users."
The "find more users" part is creative-work territory; Claude
flagged Hard Rule #1 and proposed this opt-in mechanism as the
architectural path that honors both Ray's intent and the rule's
letter.

Protocol followed:
1. Proposal raised in session.
2. Claude pointed out Rule #1's existing opt-in language
   ("opt-in plugins with explicit warnings").
3. Ray agreed the opt-in interpretation captured his intent.
4. This doc drafted, guardrails specified, exit criteria named.
5. Implementation deferred to a separate task (gs-278+).

Next session that registers Bookfinder General should:
1. Re-read this doc.
2. Confirm guardrails 1-5 still make sense.
3. Run the gs-278 implementation (if not yet landed).
4. Register Bookfinder with the new fields populated.
5. Queue initial creative-tagged tasks with clear briefs.
