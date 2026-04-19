# r/claudecode — launch post draft

**Status:** Draft 1, 2026-04-19. Ray to revise voice, post when ready.
**Target subreddit:** r/claudecode
**Audience:** Claude Code power users — familiar with hooks, settings,
MCP servers, nightly scripts, CLI flags. More technical than HN; more
friendly than HN; interested in specific patterns and how-tos, not in
philosophical essays.
**Rules of thumb:**
- Lead with what the tool does for a Claude Code user specifically.
  Polsia-positioning lands weaker here than on HN.
- Show a concrete config (their mental model is already
  `settings.json` + commands). Don't open with philosophy.
- If moderators allow screenshots, the hero image from the README
  works well here. If not, an ASCII diagram of the cycle loop is fine.
- Flair: "Show & Tell" or "Project" depending on the sub's options.

---

## Title options (pick one)

1. **I built a dispatcher that runs Claude Code on my projects every night and rolls back bad diffs automatically**
2. **GeneralStaff: local-first autopilot for Claude Code with a verification gate**
3. **Show: multi-project Claude Code dispatcher with a mandatory test gate (no more silent task-completion slop)**

Recommendation: **#1** (it's concrete and answers "what does it do for
me" in the title itself; r/claudecode readers skim, they don't parse
positioning tags).

---

## Body draft

I've been running Claude Code against a few of my side projects
unattended, and the thing that kept biting me was confident false task
completions — tests failing, scope drifted, half-baked changes marked
done. Polsia has the same problem in the closed-SaaS shape (see the
Trustpilot reviews). So I built the gate I wished existed and open-
sourced it.

**GeneralStaff** is a local-first dispatcher that picks a project
from a registry, runs Claude Code (or Codex, or anything you can
invoke with a shell command) against a git worktree, runs your
project's test suite, then runs a second Claude Code (or OpenRouter
or local Ollama) pass as a structured-JSON reviewer that checks:

- Did the tests actually pass?
- Did the diff stay in scope for the task it claimed to finish?
- Did it touch any file in the project's hands-off list?
- Did it silently fail any of the task's implicit requirements?

If any of those come back false, the cycle rolls back and the bot
loses the worktree. Master is untouched. The only branch the bot
ever writes to is `bot/work` on your own git remote. Every prompt,
response, and diff lands in a `PROGRESS.jsonl` audit log inside your
repo — you can read exactly what the bot tried and what got rejected.

### What it looks like in practice

You register a project in `projects.yaml`:

    projects:
      - id: myapp
        path: /home/ray/myapp
        engineer_command: "claude -p --dangerously-skip-permissions"
        verification_command: "bun test && bun x tsc --noEmit"
        cycle_budget_minutes: 30
        hands_off:
          - src/pricing.ts     # don't touch business logic
          - src/auth/          # don't touch security
          - CLAUDE.md          # don't touch your own instructions

Then you launch a session:

    generalstaff session --budget=90 --provider=ollama

The dispatcher picks a task from `myapp/tasks.json`, runs Claude Code
in a worktree, runs tests, spawns the reviewer (Ollama here for zero
cost), merges to master if verified, rolls back if not. Chains cycles
until the budget is hit or the queue drains. Shared state in
`state/<project>/` inside the GeneralStaff repo, never touches the
managed project's working tree.

### Numbers from the repo itself

GeneralStaff is registered as its own first project and was built
using itself — scaffold to v0.1.0 in 4 days, during which the
verification gate rejected 19 of its own proposed diffs out of 210
reviewer verdicts (~9% rejection rate). Real catches: it tried to
modify `src/safety.ts`, `src/reviewer.ts`, and `src/prompts/` at
different points and got blocked every time. You don't have to
trust the claim — the log is literal: grep
`'"verdict":"verification_failed"'` in
`state/generalstaff/PROGRESS.jsonl` and count.

### Install

One-liner on macOS / Linux:

    curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash

PowerShell on Windows:

    irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex

Auto-installs bun if you don't have it, zero root, writes only to
`./GeneralStaff/`. AGPL-3.0.

### Repo

**https://github.com/lerugray/generalstaff**

README has the full architecture, Hard Rules, dogfood numbers, and
roadmap. Phase 6 (local web dashboard) is next; mockup at
`web/index.html` previews the layout.

Happy to answer questions about the verification gate, the reviewer
provider routing, or why the hands-off list is enforced at the
filesystem layer instead of trusting the reviewer's judgment.

---

## Likely questions and drafted answers (keep in your notes)

**Q: How is this different from just setting up a cron + `claude -p` loop?**
That's actually where this started. The difference is the gate + the
hands-off list + the audit log. A naive `claude -p` loop trusts the
agent to report honestly, which it won't under scope drift. The gate
cross-checks the diff against the task and the forbidden paths. Cron
+ naive loop got me into the mess this is the answer to.

**Q: Can the reviewer be prompt-injected?**
The reviewer runs in its own Claude Code process with a locked-down
tool set (Read / Bash / Grep / Glob only — no Edit / Write). Its
output is parsed as JSON via `JSON.parse` with explicit shape
validation. A malicious diff can't persuade the reviewer to write
files; a malformed response fails safe to `verification_failed`.
The cross-check step (src/cycle.ts) re-derives hands-off violations
from the raw diff so even a lying reviewer can't bless a bad diff.

**Q: Does it work on Windows?**
Yes. All dogfood cycles were run on Windows. Security audit caught
a Windows-specific case-insensitive hands-off bypass that's fixed
in v0.1.0.

**Q: What models have you tested?**
Claude Code (engineer), Claude via `claude -p` (reviewer), OpenRouter
Qwen3 Coder (reviewer, ~$0.02/session, the default for unattended
runs), Ollama Qwen3 8B (reviewer, free, offline). Engineer is
Claude-specific for now; reviewer is pluggable.

**Q: Any plans for a hosted version?**
No. Hard Rule 10 is explicit: local-first, no SaaS tier, no managed
offering. The repo is the product.
