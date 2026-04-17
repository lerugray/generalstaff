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

## 2026-04-16 — Reference repos researched

**agent-swarm** (desplega-ai/agent-swarm, 351 stars, TS) — Lead/worker pattern with Docker. Steal: PreToolUse hooks for hands-off enforcement, PreCompact goal injection, tool loop detection, session summarization via Haiku.

**lean-ctx** (yvgude/lean-ctx, 632 stars, Rust) — MCP context compressor, 60-99% token savings. Steal: strip comments/whitespace from diffs before reviewer prompt, signature/outline mode for unchanged files, codebook deduplication.

**pi-autoresearch** (davebcn87/pi-autoresearch, 4.8K stars, TS) — Autonomous optimization loop. Steal: session resume via append-only log + narrative doc (HANDOFF.md pattern), confidence scoring with MAD, backpressure checks as non-fatal gate, finalize-to-branches for human handoff.

**API-mega-list** (cporter202/API-mega-list, 4K stars) — API aggregator. Telegram Bot API is simple HTTP POST, no SDK needed (~15 lines). Also consider ntfy.sh (zero-auth push) and Discord webhooks as alternatives.

**no-as-a-service** (hotheadhacker/no-as-a-service, 7K stars) — Joke API proving "bring your own imagination" works. Simple idea + clean execution = community adoption. Good example of project-motivation neutrality.

**logo-creator MCP** — https://mcpmarket.com/tools/skills/logo-creator-1 — MCP tool for project logos, useful for Phase 7 branding with kriegspiel theme.

## 2026-04-17 — karpathy LLM-wiki gist (persistent-context pattern)

**Source:** https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

Karpathy proposes an LLM-maintained persistent wiki as a
compounding-knowledge alternative to disposable chat context and
standard RAG. Three-layer architecture:

1. **Immutable raw sources** — articles, papers, images, prior
   conversations, commits. Never edited.
2. **LLM-owned wiki of interconnected markdown files** — the
   persistent knowledge artifact, edited continuously.
3. **Schema document** (like our CLAUDE.md) — defines the wiki's
   conventions, file roles, and workflows so the LLM knows how to
   maintain the second layer.

Three operations:
- **Ingest:** given a new source (conversation, paper, commit),
  update 10-15 related pages to incorporate what's new. Flag
  contradictions with prior claims.
- **Query:** search wiki pages at read time, synthesize answer
  from the already-compiled knowledge (not from the raw sources).
  Optionally file discoveries back into the wiki.
- **Lint:** periodic health check — contradictions, orphaned
  pages, stale claims, broken cross-references.

**Why this maps onto what GeneralStaff already does informally:**
CLAUDE.md is the schema document. research-notes.md, DESIGN.md,
FUTURE-DIRECTIONS-*.md, PHASE-*.md are the interconnected wiki.
Git commits + PROGRESS.jsonl + Telegram messages + external repos
are the immutable raw sources. What we've been missing is the
**explicit Ingest step at end-of-session** — currently the LLM
(me) ingests sources incrementally during the session but doesn't
consolidate into wiki updates before ending. That's the gap Ray
flagged 2026-04-17 afternoon ("we failed to capture session notes
last session"). The gist formalizes the obligation.

**Novel vs generic RAG:** the LLM generates the knowledge base
itself, not just retrieves from it. Synthesis happens continuously
during ingestion, not at query time. Human curation drives source
selection; the LLM does the bookkeeping. Referential integrity is
maintained across pages via explicit cross-references, not by
semantic similarity.

**Conceptual lineage:** Vannevar Bush's Memex (1945). Explicitly
rejects the disposable chat-history model that currently dominates
LLM assistant UX.

**Applicability to GeneralStaff specifically:**
- The end-of-session **Ingest** step is a human-interactive-session
  responsibility (not bot — docs/sessions/ is hands-off and it's
  creative/taste work per Rule 1).
- The **Lint** operation could plausibly be a low-stakes bot task
  later (check cross-references, flag orphaned docs, find stale
  date references — bounded correctness work). Not a Phase 2
  deliverable; capture as a Phase 4+ candidate.
- The **Query** operation is what a future user-facing GS
  subcommand like `generalstaff ask "what's our stance on X?"`
  could do against the vault — relates to the vault plugin in
  FUTURE-DIRECTIONS §6 but as an internal tool first, corpus-of-
  my-own-docs before corpus-of-my-whole-life.

**Adjacent karpathy refs we've now captured:**
- karpathy/autoresearch — optimization-loop pattern (informs gs-149
  pi-autoresearch analogy)
- This gist — LLM-wiki pattern (informs end-of-session tracking
  obligation captured 2026-04-17)
- The two are complementary: autoresearch = how the bot does its
  work; LLM-wiki = how the human and assistant maintain shared
  memory across sessions.

## 2026-04-17 — Playwright + Chrome-extension Claude precedent (stub)

**Source:** Ray's own prior work, not external. Captured during
the 2026-04-17 afternoon chat about Claude Design UI automation.

**The pattern:** catalogdna (and reportedly "others" in Ray's
project portfolio) have historically used Playwright to drive
Claude in the Chrome extension / web app — sessions communicate
with a logged-in Claude subscription via browser automation
rather than via Anthropic's API. This is how "the webapp" worked
in at least one of those projects.

**Why this stub exists:** the exact mechanism (entry point,
login handling, extraction path, how Claude's response is
captured out of the DOM) is NOT documented here yet. Ray
confirmed the pattern exists; details are in the catalogdna
repo or possibly elsewhere. A future interactive session that
needs this (likely Phase 4+ if Anthropic hasn't shipped a
Claude Design API by then) should start by reading that repo's
scripts directory for the Playwright glue.

**Relevance to GeneralStaff:**
- Potential Phase 4+ automation vector for Claude Design if
  Anthropic's API ships late.
- ALSO a potential Engineer-role provider option per Phase 2's
  "engineer swap to aider or opencode with Qwen" (FUTURE-
  DIRECTIONS §2). If we're willing to automate a logged-in
  Claude subscription, that's another path to the same
  cost-profile shift.

**Hard Rule 8 tension:** the rule says subscription use is
"opt-in personal-use only" — deliberately cautious about
automating consumer Anthropic subscriptions because of ToS
gray area (RULE-RELAXATION §5.2). Any GeneralStaff-shipped
feature that uses this pattern has to either (a) be clearly
labeled as personal-use-only opt-in with warnings, or (b)
wait for Anthropic to bless automation via API. Prefer (b)
where possible.

**Not a task.** Stub only; revisit when Phase 4 opens.

## 2026-04-17 — Drafter-reviewer pattern convergence

**Source:** 2026-04-17 evening chat assessing three new repos Ray
flagged. Pattern-matching insight, not a new external reference.

At least **four independent Claude Code frameworks** have now
converged on the drafter-reviewer (or engineer-reviewer) pattern
as the core architecture:

1. **GeneralStaff** — Engineer writes code, Reviewer verifies
   against hands-off list + scope-drift + silent-failure criteria.
2. **pi-autoresearch** (davebcn87) — Drafter runs an experiment,
   reviewer compares against noise floor, reverts on regression.
3. **desplega-ai/agent-swarm** — Lead agent plans and delegates,
   worker agents execute, lead reviews.
4. **MadsLorentzen/ai-job-search** — Drafter agent writes CV + cover
   letter, reviewer agent critiques, drafter revises.

None of these cross-cite each other, which means the pattern is
being independently discovered. That's a strong convergence
signal — the architecture isn't GeneralStaff-specific, it's the
natural shape autonomous LLM work takes when correctness matters.

**Launch-article material:** frame GeneralStaff as the version
that *names* and *structurally enforces* the pattern via Hard
Rule 1 (correctness vs. taste split). The other three projects
use it implicitly; GeneralStaff makes it explicit and builds
governance around it (verification gate, hands-off enforcement,
audit log). That's the difference between a pattern and a
product.

**Why this matters beyond the article:** if the pattern is
converging across the ecosystem, our implementation choices
stop being bespoke and become shared primitives. Future
interoperability (e.g., swapping reviewers across projects,
importing task formats, sharing calibration harnesses) becomes
plausible. Not a near-term concern, but worth noting.

## 2026-04-17 — TimesFM for Phase 12+ Kriegspiel simulation

**Source:** https://github.com/google-research/timesfm
**Paper:** A decoder-only foundation model for time-series
forecasting (ICML 2024)

Google Research's pretrained time-series foundation model.
Currently at 2.5, 200M params, 16k context, quantile forecast
head. MIT-adjacent public availability via Hugging Face; also
shipped as a BigQuery ML function, Google Sheets feature, and
Vertex AI endpoint.

**Why relevant:** FUTURE-DIRECTIONS §1 (Simulation / Kriegspiel
Mode, Phase 12+) explicitly requires *"confidence intervals,
not single numbers"* — the design-critical constraint that
separates honest forecasts from false-confidence slop. TimesFM's
quantile head produces exactly this shape (p10/p50/p90 across a
forecast horizon). For projects with historical metrics
(revenue, signups, churn, rating), TimesFM could ground the
simulation's forecast layer in a real neural model rather than
hand-waved projections.

**Complementary to the tools §1 already lists** (Mesa for
agent-based, SimPy for discrete events, PyMC for Bayesian,
scipy.stats for basic sampling): TimesFM is the "structured
time-series foundation" slot those don't fill.

**Shape for GeneralStaff integration (Phase 12+, not soon):**
`generalstaff simulate <project>` reads campaign_plan.md + any
historical metrics the project exposes, runs TimesFM locally for
KPI projections with quantiles, pipes results to a human-readable
report (go/no-go recommendation with rationale). Hard Rule 10
compatible — TimesFM runs locally via Hugging Face; no cloud
egress required.

**Not a task.** Capture only; revisit when Phase 12 opens.

## 2026-04-17 — ai-legal-claude: curl-install pattern (distribution)

**Source:** https://github.com/zubair-trabzada/ai-legal-claude

Tool itself (14-skill Claude Code legal-review suite) is not
relevant to GeneralStaff's scope. **Install pattern is.**

The repo ships with a one-command installer:

```bash
curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
```

That's the right distribution shape for FUTURE-DIRECTIONS §10's
non-programmer audience (Phase 5+). A music teacher installing
GeneralStaff should not need `git clone`, `bun install`, and a
YAML-editing session. A single curl line is.

**Not as hostile to the principled-security stance as it looks:**
`curl | bash` gets criticism, but the alternative for Phase 5+
users (cloning + installing Bun manually + running CLI commands)
is strictly worse for adoption. The honest path is: ship the
script, publish its source prominently, let the skeptical read
it before piping. Same pattern Homebrew, Bun, and others use.

**Skepticism noted:** the repo's README has "check out the
Skool community" — growth-hacking/funnel energy. Not what we
want to emulate. The technical pattern is good; the marketing
pattern is bad.

**Hold for Phase 5+.** Not a task; referenced when the install-
flow design work happens.

## 2026-04-17 — Claude Design launched (Anthropic, 2026-04-17)

**Source:** https://venturebeat.com/technology/anthropic-just-launched-claude-design-*

Anthropic shipped **Claude Design** on 2026-04-17 — a Figma/
Adobe competitor, research preview, available to paid Claude
subscribers. Powered by Claude Opus 4.7. Generates website
prototypes, slide decks, design systems, one-pagers from prompts;
refined via chat + inline comments + sliders. Assumes
non-designer user.

**Plan for GeneralStaff Phase 4** (UI work, not soon):
- When Phase 4 opens, do ONE manual Claude Design session to
  validate the UI-VISION aesthetic (19th-century lithograph,
  brass fittings, Prussian palette, Kriegspiel campaign map)
  can be hit by the tool.
- If yes: use it to generate 3-5 mockups for `docs/ui-mockups/`
  that become the design-first artifact for Tauri implementation.
- If no: fall back to manual design; don't force it.
- **Don't queue a task yet.** Too many unknowns (aesthetic fit,
  export formats, API timing).

**Rule 8 consideration:** Ray's catalogdna Playwright-Claude
pattern (captured above) could automate Claude Design access
via browser, but the subscription-automation path is exactly
what Rule 8 is cautious about. Prefer waiting for Anthropic
to ship a Claude Design API (likely within 1-3 months given
their pace). Personal-use automation is fine; shipping the
automation to OSS users is the line.

**Adjacent data point:** Anthropic's CPO left Figma's board
2026-04-16, one day before the launch. Non-trivial corporate
signal that Anthropic is committed to the design market — the
tool won't be abandoned.
