# GeneralStaff — Research Notes

Source material informing the architecture in `DESIGN.md`. **Append-only,
dated.** Don't rewrite — add new sections.

---

## 2026-04-13 — Background research agent report

Background agent dispatched during the design conversation that created
this folder. Task: survey reference implementations of autonomous Claude
Code overnight loops + multi-project dispatchers, report what's worth
stealing and what to avoid. Report archived verbatim below.

### nightcrawler — FOUND

Repo: github.com/thebasedcapital/nightcrawler
Detailed writeup at dev.to (referenced in agent report).

**Patterns worth stealing:**
- **File-based state trio**: `STATE.json` (current world state),
  `HANDOFF.md` (narrative handoff from previous episode), `tasks.json`
  (work queue), `PROGRESS.jsonl` (append-only log), plus a static
  `MISSION.md`. Each episode reads all of these, writes updates at end.
  Per-episode checkpoints + logs let you reconstruct post-mortem.
- **Session opening ritual**: every episode does read STATE → read
  HANDOFF → `git log` to *verify* the previous episode's claims against
  reality → run baseline checks (tests/lint) → only then pick highest-
  priority task. This is the crash-recovery pattern — don't trust the
  handoff, trust git.
- **Orchestrator spawns bounded episodes** via `claude -p
  --dangerously-skip-permissions --model X --max-budget-usd Y`. Each
  episode is fresh context; reliability comes from accepting that
  sessions die.

**Red flags:**
- 8 termination conditions is a lot to maintain; start with 3 (budget,
  error count, stop-flag file).
- `--dangerously-skip-permissions` is the price of unattended operation
  — only safe if the git-verification ritual actually catches bad
  handoffs.

### parallel-cc — FOUND

Repo: github.com/frankbria/parallel-cc
Related: johannesjo/parallel-code (desktop GUI), automazeio/ccpm
(GitHub Issues + worktrees).

**Patterns worth stealing:**
- **Auto-detect parallel session → create isolated worktree per task.**
  Branch-per-task is the unit of isolation; main repo stays clean.
- **`--git-live` mode** pushes commits to a remote feature branch and
  opens a PR on completion — review happens async on GitHub, not in a
  terminal you have to watch.
- Two modes (local worktree for interactive / E2B cloud sandbox for
  long autonomous runs) — clean separation of "I'm at the keyboard" vs
  "I'm asleep."

**Red flags:**
- E2B sandbox mode costs money and adds a dependency — skip for
  GeneralStaff v1.
- Worktree-per-task across 5 projects means 5+ worktrees at once; disk
  + cognitive overhead. Probably want **worktree-per-project, not
  per-task**.

### Polsia — FOUND (SaaS, no public architecture)

polsia.com, Mixergy interview, podcasttranscript.ai transcript. GitHub
org PolsiaAI exists but publishes nothing substantive about internals.

**Patterns worth stealing:**
- **Role-specialized agents with scoped tool access**: engineer gets
  web server + GitHub + DB; marketing gets Twitter + email + Meta Ads;
  support gets email. The tool boundary *is* the role definition. Map
  this to Planner (read-only + plan file writes), Engineer (git + file
  edits), Reviewer (git read + PR comment).
- **PM → Engineer → QA pipeline with a human escalation gate**: QA
  agent decides push-to-prod OR notify-human. That escalation gate is
  the solo-user review loop. GeneralStaff's Reviewer should always end
  in "merge" or "escalate with summary."
- **Persistent memory threads across tasks** via MCP. For file-based,
  that's just per-project `memory/` dirs appended between runs.

**Red flags:**
- Polsia is closed-source; reverse-engineering from marketing. Don't
  over-index.
- "80% autonomous" is a marketing number; the 20% is where trust lives.
  Budget for it.

### Continuous-Claude-v3 — FOUND

Repo: github.com/parcadei/Continuous-Claude-v3
Over-engineered for a solo user, but hooks concept is the stealable gem.

**Patterns worth stealing:**
- **Lifecycle hooks** map 1:1 to Claude Code's native hook events
  (`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `PreCompact`, `SubagentStop`, `SessionEnd`). The pattern: use
  `SessionStart` to inject STATE/HANDOFF into context automatically (no
  prompt boilerplate), use `SessionEnd` to force a handoff-write.
  Deterministic, not prompt-dependent.
- **Ledgers + handoffs written by hooks rather than by the model**
  means state survives even if the model forgets to update it.

**Red flags:**
- 32 agents, 30 hooks, 109 skills, PostgreSQL + pgvector daemon — this
  is an enterprise framework cosplaying as a dev tool. The PostgreSQL
  heartbeat-daemon-spawns-headless-Sonnet thing is architectural
  theatre for a solo user.
- Ignore the vector memory; file grep is fine at this scale.

### Synthesis — Top 3 Decisions for GeneralStaff

Per the agent's recommendation:

1. **Per-project state directory with the nightcrawler file set, not
   per-task worktrees.** Each project gets `.generalstaff/{STATE.json,
   HANDOFF.md, tasks.json, PROGRESS.jsonl, MISSION.md}`. The
   dispatcher's only job is pick-project-and-spawn-episode.
   Parallel-cc's worktree pattern is the wrong axis for us — we're
   sequencing across projects, not parallelizing within one.

2. **Git-as-source-of-truth verification ritual, borrowed from
   nightcrawler.** Every Planner session begins with
   `git log --since="last episode" && git status` and compares to
   HANDOFF claims. If they disagree, the episode stops and escalates.
   This is the single most important reliability pattern in the research
   — it's what converts "overnight loop" from "wishful thinking" into
   "actually resumes after a crash."

3. **Claude Code native hooks (C-C-v3 pattern) for state I/O, not
   prompts.** Wire `SessionStart` to cat STATE.json + HANDOFF.md into
   context, wire `SessionEnd` (or `Stop`) to force-write the next
   HANDOFF. This removes the "did the model remember to update state?"
   failure mode entirely — hooks run deterministically. Combined with
   Polsia's role-scoped tool access (Planner: read+plan-write; Engineer:
   full; Reviewer: read+PR-comment), you get a Planner→Engineer→Reviewer
   chain where each role literally cannot do the wrong thing.

**Non-obvious recommendation:** skip `--git-live` auto-PR for v1. The
reviewer-escalates-with-summary pattern from Polsia is safer — the
Reviewer agent writes a `REVIEW.md` and either commits directly or
flags for the morning inbox. PRs are the right shape when you have
teammates; for a solo founder reviewing 5 projects, a single "morning
digest" file per project is faster to triage.

### Sources

- nightcrawler repo: github.com/thebasedcapital/nightcrawler
- "Why Your Overnight AI Agent Fails" (DEV.to): dev.to/thebasedcapital
- parallel-cc repo: github.com/frankbria/parallel-cc
- parallel-code (johannesjo): github.com/johannesjo/parallel-code
- ccpm (automazeio): github.com/automazeio/ccpm
- Polsia Mixergy interview: mixergy.com/interviews/this-ai-generates-689k/
- Polsia podcast transcript: podcasttranscript.ai/library/agents-at-work-21-...
- Polsia site: polsia.com
- Continuous-Claude-v3 repo: github.com/parcadei/Continuous-Claude-v3
- Claude Code Hooks reference: code.claude.com/docs/en/hooks
- 12 lifecycle events guide: claudefa.st/blog/tools/hooks/hooks-guide
