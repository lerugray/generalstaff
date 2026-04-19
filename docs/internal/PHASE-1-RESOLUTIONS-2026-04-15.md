# Phase 1 Open Questions — Resolved (2026-04-15 evening)

Resolves the 5 open questions from `PHASE-1-PLAN-2026-04-15.md`
with enough detail that the next build session can execute
without further design work.

**Q4 is Ray's call.** Q5 was delegated to me ("just make sure
it's safe") — I chose the safety-first approach and explain the
reasoning below. Q1, Q2, Q3 are design artifacts drafted here so
the next build session has concrete specs to implement against.

---

## Q1: Work detection for chaining

**Answer:** Parse `bot_tasks.md` and count unchecked `- [ ]`
items under `## P0` through `## P3` section headers. Skip Phase
A and Phase B sections (self-directed, fluid). Skip any
P-section whose header contains "COMPLETED" or "SKIP"
(indicates the task was moved to interactive work and marked
stale).

**Pseudocode** (to live in `src/work_detection.ts`):

```typescript
function hasMoreWork(project: Project): boolean {
  switch (project.work_detection) {
    case "catalogdna_bot_tasks":
      return catalogdnaHasMoreWork(project.path);
    case "tasks_json":
      return greenfieldHasMoreWork(project.id);
    default:
      return false;  // unknown mode: fail-safe, no chaining
  }
}

function catalogdnaHasMoreWork(catalogdnaPath: string): boolean {
  const botTasksPath = path.join(catalogdnaPath, "bot_tasks.md");
  if (!fs.existsSync(botTasksPath)) return false;

  const content = fs.readFileSync(botTasksPath, "utf8");
  // Split into sections by top-level ## headers
  const sections = content.split(/^## /m);

  let totalUnchecked = 0;
  for (const section of sections) {
    const firstLine = section.split("\n")[0] ?? "";
    // Only count P0-P3 sections
    if (!/^P[0-3]\b/.test(firstLine)) continue;
    // Skip completed/skipped sections
    if (/COMPLETED|SKIP/i.test(firstLine)) continue;
    // Count unchecked boxes
    const unchecked = (section.match(/^- \[ \]/gm) ?? []).length;
    totalUnchecked += unchecked;
  }

  return totalUnchecked > 0;
}

function greenfieldHasMoreWork(projectId: string): boolean {
  const tasksPath = path.join(
    generalStaffRoot,
    "state",
    projectId,
    "tasks.json",
  );
  if (!fs.existsSync(tasksPath)) return false;
  const tasks = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
  return tasks.some(
    (t: any) => t.status !== "done" && t.status !== "skipped",
  );
}
```

**Chaining decision** (combines work-detection with time and
outcome checks):

```typescript
const MAX_CYCLES_PER_PROJECT_PER_SESSION = 3;  // config value, not hardcoded

function shouldChain(
  lastCycle: Cycle,
  project: Project,
  session: Session,
): { chain: boolean; reason: string } {
  if (lastCycle.verdict === "verification_failed") {
    return { chain: false, reason: "last cycle failed verification" };
  }

  const cyclesOnThisProject = session.cycles.filter(
    c => c.projectId === project.id,
  ).length;
  if (cyclesOnThisProject >= session.maxCyclesPerProject) {
    return { chain: false, reason: "per-project cycle cap reached" };
  }

  const remaining = session.budgetMinutes - session.elapsedMinutes();
  const nextMinimum = project.cycle_budget_minutes + 5;  // 5 min grace
  if (remaining < nextMinimum) {
    return { chain: false, reason: "insufficient session budget" };
  }

  if (!hasMoreWork(project)) {
    return { chain: false, reason: "no remaining work for this project" };
  }

  return { chain: true, reason: "more work, budget ok, last cycle passed" };
}
```

**Edge cases handled:**

- `bot_tasks.md` doesn't exist → `hasMoreWork` returns false, no
  chaining (not an error)
- `bot_tasks.md` is malformed → fail-safe, return false (don't
  grind on corrupted state)
- P-section with "COMPLETED INTERACTIVELY — SKIP" header → not
  counted even if its checkboxes are unchecked
- All P sections empty but Phase A/B has items → `hasMoreWork`
  returns false; Phase A/B is self-directed, not a signal that
  GeneralStaff should dispatch another cycle

**New `projects.yaml` field:** `work_detection: catalogdna_bot_tasks`
(or `tasks_json`, default).

---

## Q2: Reviewer agent prompt template

**Answer:** The full template lives at `src/prompts/reviewer.ts`.
Filled by `src/reviewer.ts` before spawning `claude -p`.
Placeholders in `${UPPER_CASE}`.

### Template

```
You are the Reviewer agent for GeneralStaff, reviewing one cycle
of work on the ${PROJECT_ID} project.

Your job is SCOPE MATCH. Given the diff produced by this cycle
and the tasks the Engineer agent claims to have completed,
confirm that the diff actually matches the claimed work. This is
the final gate before a cycle is marked done — if you cannot
confirm the match, the cycle does NOT get marked done.

You have read-only access. You cannot edit files. You CAN run
git commands and read any file in the project.

## The cycle's claimed work

The Engineer marked these tasks as done during this cycle:

${MARKED_DONE_TASKS}

The Engineer's session note (if one was written during the
cycle):

${SESSION_NOTE_OR_NONE}

## The diff

Full diff between cycle start and cycle end:

${FULL_DIFF}

Diff summary: ${DIFF_STAT}

## Independent verification output

The dispatcher ran the verification command after the Engineer
finished, independently of whatever the Engineer ran internally:

Command: `${VERIFICATION_COMMAND}`
Exit code: ${VERIFICATION_EXIT_CODE}

Output:

${VERIFICATION_OUTPUT_TRUNCATED}

## Hands-off list

These files (or glob patterns) must NOT appear in the diff. A
single match means the cycle failed.

${HANDS_OFF_LIST}

## Your task

Examine the diff and answer these questions:

1. **Scope match:** Does every file changed in the diff relate
   to one of the marked-done tasks? Any files changed that
   don't correspond to any claimed work? Touching a test file
   to support a claimed bug fix IS fine; touching an unrelated
   module is scope drift.

2. **Hands-off violations:** Does the diff touch any file
   matching a pattern in the hands-off list? Glob patterns
   should be matched (e.g., `run_bot*.sh` matches
   `run_bot_publish.sh`).

3. **Task completion evidence:** For each marked-done task,
   does the diff contain changes that plausibly complete it?
   You are NOT grading correctness — just checking that the
   claimed work has corresponding evidence.

4. **Silent failures:** Did the Engineer mark something done
   that the diff doesn't reflect? Did it claim to fix a test
   that's still failing in the verification output?

## Verdict format

Respond with a JSON object only. No prose before or after the
JSON. No markdown code fences around the JSON.

{
  "verdict": "verified" | "verified_weak" | "verification_failed",
  "reason": "one sentence explaining the verdict",
  "scope_drift_files": [
    "list of files in diff that don't match any claimed task"
  ],
  "hands_off_violations": [
    "list of files in diff that match a hands_off pattern"
  ],
  "task_evidence": [
    {
      "task": "exact marked-done task line",
      "evidence": "how the diff supports this",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "silent_failures": [
    "list of claimed-done items with no diff evidence"
  ],
  "notes": "anything else the human reviewer should see"
}

## Verdict rules

- **verified**: verification exit code is 0 AND no scope drift
  AND no hands_off violations AND every marked-done task has at
  least medium-confidence evidence
- **verified_weak**: everything is verified EXCEPT the
  verification command was effectively a no-op (empty, `true`,
  `:`), OR your task evidence is entirely low-confidence (no
  strong evidence for any claimed task)
- **verification_failed**: anything else — verification exit
  non-zero, scope drift detected, hands_off violation detected,
  claimed task has no diff evidence, or silent failure detected

When in doubt, err on the side of `verification_failed`. The
cost of a false `verified` is much higher than the cost of a
false `verification_failed`. False verified is the Polsia
failure mode; false failed just means a human looks at the
diff.
```

### Spawn invocation

```bash
claude -p "$(cat state/${PROJECT_ID}/cycles/${CYCLE_ID}/reviewer-prompt.txt)" \
  --allowedTools "Read,Bash,Grep,Glob" \
  --cwd "${PROJECT_PATH}"
```

The Reviewer gets `Read,Bash,Grep,Glob` — deliberately **no**
`Write`, `Edit`, or `NotebookEdit`. It cannot modify files. It
can run git commands via Bash (needed to inspect diffs, check
file contents beyond the diff, verify hands_off pattern
matches).

### Parsing the response

The response should be parseable JSON. If JSON parsing fails,
the verdict defaults to `verification_failed` with reason
"reviewer response was not valid JSON" — fail-safe. A malformed
Reviewer response is treated as a verification failure, not a
verified pass.

### Prompt tuning notes

The template currently doesn't ask the Reviewer to run its own
tests (that's the dispatcher's job via `verification_command`).
It also doesn't ask the Reviewer to read the engineer log (too
much noise; the diff and verification output are the ground
truth). These could be added if the first 5 cycles surface
blind spots.

---

## Q3: Concurrent-run detection

**Answer:** Check three signals. If ANY signal indicates a run
is in progress, refuse to start a GeneralStaff cycle on
catalogdna (log `cycle_skipped`, rotate to next project or
exit the session).

### Signal 1: `.bot-worktree/` exists and is fresh

`run_bot.sh` creates `.bot-worktree/` at the start of a run and
removes it (via `git worktree remove`) at the end of a clean
run. If the directory exists and was modified within the last
10 minutes, a run is probably in progress (or crashed very
recently, and we don't want to race with a recovery).

### Signal 2: `bot_status.md` shows a current task

catalogdna's bot writes `bot_status.md` at the start of each
task. Active format includes a `Current task:` line. Idle
format is `Status: idle`. If the file exists and contains
`Current task:` without a current `Status: idle`, a run is
probably active.

### Signal 3: heartbeat sentinel is fresh

`run_bot_publish.sh` creates `logs/heartbeat_${TS}.sentinel` at
the start of a publish-mode run and removes it on clean exit.
If any such sentinel in `logs/` was modified within the last 20
minutes (heartbeat interval is 15 min, 20 min gives a small
buffer), a publish-mode run is probably active.

### Pseudocode

```typescript
function isBotRunning(
  project: Project,
): { running: boolean; reason?: string } {
  if (project.concurrency_detection !== "catalogdna") {
    return { running: false };  // greenfield: no signals yet
  }

  // Signal 1: .bot-worktree
  const worktreePath = path.join(project.path, ".bot-worktree");
  if (fs.existsSync(worktreePath)) {
    const stat = fs.statSync(worktreePath);
    const ageMin = (Date.now() - stat.mtimeMs) / 60_000;
    if (ageMin < 10) {
      return {
        running: true,
        reason: `.bot-worktree exists, modified ${ageMin.toFixed(0)} min ago`,
      };
    }
  }

  // Signal 2: bot_status.md non-idle
  const statusPath = path.join(project.path, "bot_status.md");
  if (fs.existsSync(statusPath)) {
    const content = fs.readFileSync(statusPath, "utf8");
    const hasCurrentTask = /Current task:/.test(content);
    const isIdle = /Status:\s*\*?\*?\s*idle/i.test(content);
    if (hasCurrentTask && !isIdle) {
      return {
        running: true,
        reason: "bot_status.md shows active task (not idle)",
      };
    }
  }

  // Signal 3: heartbeat sentinel
  const logsDir = path.join(project.path, "logs");
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      if (!f.startsWith("heartbeat_") || !f.endsWith(".sentinel")) continue;
      const stat = fs.statSync(path.join(logsDir, f));
      const ageMin = (Date.now() - stat.mtimeMs) / 60_000;
      if (ageMin < 20) {
        return {
          running: true,
          reason: `recent heartbeat sentinel: ${f}`,
        };
      }
    }
  }

  return { running: false };
}
```

### False positive risk

Stale `.bot-worktree/` from a crashed run, or stale
`bot_status.md` with non-idle content left over from an
incomplete session. Handled by:

- `.bot-worktree` age check (< 10 min)
- Relying on the bot's own discipline to write "Status: idle"
  on exit (catalogdna bot's wind-down protocol does this; if it
  doesn't, that's a catalogdna bot bug to fix separately)

### False negative risk

Ray is interactively editing catalogdna but not running the
bot. None of the three signals would catch this. Mitigation:
the test window discipline (Q4) — GeneralStaff test cycles only
run during planned windows when Ray is not at the keyboard.
This is a planning issue, not a detection issue. Adding a
"Ray is coding" lock file would be brittle; a planning rule is
simpler and harder to forget.

### Skip handling

If a cycle is refused due to concurrency, the dispatcher:

1. Writes a `cycle_skipped` entry to PROGRESS.jsonl with the
   reason
2. Does NOT increment the cycle count for this project (skips
   don't count toward the cap)
3. Moves to the next project in the picker (or exits the
   session if no more eligible projects)

**New `projects.yaml` field:**
`concurrency_detection: catalogdna` (or `none`, default).

---

## Q4: First test cycle target window

**Answer:** Thursday 2026-04-16 night. Ray confirmed on
2026-04-15 evening: *"working from home on friday so tomorrow
night is more viable."*

### Preconditions before starting the first cycle

1. catalogdna's working tree is clean (no uncommitted changes
   on master)
2. `isBotRunning(catalogdna)` returns false across all three
   signals (Q3)
3. Ray is not actively coding catalogdna — a **planned window**,
   not "probably fine"
4. GeneralStaff Phase 1 code is implemented through build order
   step 18 (dry-run working) and step 17 (catalogdna
   `state/catalogdna/` directory initialized)

### Supervised first cycle procedure

1. Ray triggers manually: `bun run cli.ts session --budget=60`
2. GeneralStaff runs one cycle on catalogdna (the picker only
   has catalogdna to choose from in Phase 1)
3. Ray watches the session output live
4. When the cycle completes, Ray reads:
   - `state/catalogdna/PROGRESS.jsonl` (full audit trail)
   - `state/catalogdna/REVIEW.md` (Reviewer verdict)
   - `state/catalogdna/cycles/${cycle_id}/diff.patch`
   - `state/catalogdna/cycles/${cycle_id}/verification.log`
   - `state/catalogdna/cycles/${cycle_id}/reviewer-response.txt`
   - The local digest file
5. Ray decides manually: merge `catalogdna/bot/work` into
   `catalogdna/master`, or reject and roll back
6. If merged, commit count on catalogdna advances; GeneralStaff
   logs the first successful cycle in `fleet_state.json`
7. Ray flags any issues for iteration before cycle 2

### Cycles 2-5

One per night for the next 4 nights, same supervised procedure,
iterating on bugs surfaced by cycle 1. After 5 clean supervised
cycles, Phase 1 is considered done per Hard Rule #4's "5 clean
cycles" threshold.

### Expected first-cycle outcome

Probably `verification_failed` with a clear reason Ray can fix
in the next build session. Almost every first live integration
surfaces bugs in:

- The Reviewer prompt (template placeholders, verdict parsing)
- The Engineer subprocess wrapper (output capture, timeout)
- The verification gate (wrong working directory, wrong env,
  path resolution)

A successful first cycle would be pleasantly surprising. Plan
for iteration, not perfection.

---

## Q5: State directory location — OUTSIDE catalogdna

**Answer:** GeneralStaff's state for every project lives INSIDE
GeneralStaff's own directory, not inside the project it's
managing. **Nothing is written to catalogdna's working tree by
GeneralStaff.** The only writes into catalogdna's working tree
come from `engineer_command` (which is catalogdna's own bot
doing its own thing on its own `bot/work` branch — unchanged
from current behavior).

### New directory layout

```
C:/Users/rweis/OneDrive/Documents/GeneralStaff/    (git repo: lerugray/generalstaff)
├── README.md                                      (existing design docs)
├── DESIGN.md
├── PIVOT-2026-04-15.md
├── RULE-RELAXATION-2026-04-15.md
├── PHASE-1-PLAN-2026-04-15.md
├── PHASE-1-RESOLUTIONS-2026-04-15.md              (this file)
├── PHASE-1-SKETCH-2026-04-15.md                   (historical)
├── UI-VISION-2026-04-15.md
├── INDEX.md
├── CLAUDE.md
├── projects.yaml                                  (new in Phase 1)
├── fleet_state.json                               (new — global fleet state)
├── STOP                                           (optional kill switch)
├── next_project.txt                               (optional picker override)
├── logs/
│   └── session_${TS}.log
├── state/                                         (NEW — per-project state)
│   ├── catalogdna/
│   │   ├── MISSION.md
│   │   ├── STATE.json
│   │   ├── HANDOFF.md
│   │   ├── tasks.json                             (empty; catalogdna uses bot_tasks.md)
│   │   ├── PROGRESS.jsonl
│   │   ├── REVIEW.md
│   │   └── cycles/
│   │       └── ${cycle_id}/
│   │           ├── engineer.log
│   │           ├── diff.patch
│   │           ├── reviewer-prompt.txt
│   │           ├── reviewer-response.txt
│   │           └── verification.log
│   └── (future: retrogaze/, sandkasten/)
├── src/                                           (Phase 1 code)
└── tests/
```

### Why this is the safe default

1. **catalogdna's working tree is never touched by GeneralStaff.**
   Any `git add -A` in catalogdna — whether by Ray, catalogdna's
   bot, or anything else — cannot accidentally pull in GeneralStaff
   state files because those files don't exist inside catalogdna.
2. **catalogdna's public repo stays clean.** If catalogdna
   eventually ships publicly, there's no GeneralStaff state
   lurking in the history to accidentally expose.
3. **Cross-machine sync is unambiguous.** GeneralStaff state
   syncs via GeneralStaff's private git repo
   (`lerugray/generalstaff`). catalogdna syncs via catalogdna's
   git repo. No overlap, no confusion about which repo owns
   which file.
4. **The .gitignore question disappears.** We don't need to add
   `.generalstaff/` to catalogdna's `.gitignore` because there
   is nothing to ignore — the path doesn't exist in catalogdna.
5. **Matches the meta-dispatcher framing.** GeneralStaff is a
   fleet manager. The fleet manager keeps its own state. Each
   project is an independent unit the manager observes.

### What this means for the dispatcher

- GeneralStaff READS from catalogdna's working tree freely
  (bot_tasks.md, bot_status.md, docs/Sessions/, git state via
  `git log` / `git diff`)
- GeneralStaff WRITES only to `state/catalogdna/` inside
  GeneralStaff's own repo
- The Engineer subprocess (`bash run_bot.sh`) runs with
  `cwd=catalogdna` and writes to catalogdna's working tree on
  the `bot/work` branch (unchanged from current catalogdna
  behavior)
- The Reviewer agent runs with `cwd=catalogdna` (so it can
  `git log`, `git diff`, read catalogdna files) but its prompt,
  response, and verdict are all written by GeneralStaff to
  `state/catalogdna/cycles/${cycle_id}/`, not to catalogdna

### projects.yaml schema changes

- `mission_file` field is **removed**. The dispatcher auto-
  derives the mission path from the project ID:
  `mission_path = generalStaffRoot / "state" / project.id / "MISSION.md"`.
  Less config, less chance of misconfiguration.
- `verification_command` is **inline**, not a wrapper script
  inside catalogdna. Writing `scripts/verify_for_generalstaff.sh`
  into catalogdna would be writing GeneralStaff-specific
  infrastructure into catalogdna's repo — exactly the
  contamination pattern Q5 is preventing. Inline in
  `projects.yaml` keeps the coupling one-directional:
  GeneralStaff knows about catalogdna's test invocation;
  catalogdna doesn't know about GeneralStaff.

### Design refinement note

The file layout in `DESIGN.md` v2 shows a per-project
`.generalstaff/` directory INSIDE each project. That was the
original nightcrawler-inspired pattern. This resolution
supersedes that layout for Phase 1. DESIGN.md v2 gets a brief
refinement note pointing at this file; the original layout is
preserved as historical context per the append-only convention.

### Follow-up action item

`projects.yaml.example` was committed in Phase 0 with the v1
schema (no `work_detection`, no `concurrency_detection`,
mission_file field present). The next build session should
update it in step 1 (project bootstrap) to match the current
schema. Not blocking — flagged so it doesn't get lost.

---

**Captured:** 2026-04-15 evening, GeneralStaff pivot session
**Resolves:** 5 open questions from
`PHASE-1-PLAN-2026-04-15.md`
**Referenced by:** `PHASE-1-PLAN-2026-04-15.md`, `DESIGN.md` v2
(refinement note)
**Next:** Next build session opens `PHASE-1-PLAN` + this file
and starts at build order step 1 (project bootstrap). No more
design work needed before code lands.
