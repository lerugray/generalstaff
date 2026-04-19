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

1. **I built and open-sourced an improved Polsia in 4 days, thanks to Claude and Hammerstein** (Ray's)
2. **I built a dispatcher that runs Claude Code on my projects every night and rolls back bad diffs automatically**
3. **GeneralStaff: local-first autopilot for Claude Code with a verification gate**
4. **Multi-project Claude Code dispatcher with a mandatory test gate (no more silent task-completion slop)**

Recommendation: **#1** (Ray's). Concrete timeline, names the
comparison target, credits the tools honestly. The "thanks to
Claude and Hammerstein" ending is warm in a way r/claudecode's
audience will read as genuine rather than marketing. "Improved"
is slightly spicy but r/claudecode is friendlier than HN and the
anti-slop architecture backs the claim. #2 is the fallback if
"improved Polsia" reads as combative in the moment.

---

## Body draft

I've been running Claude Code against a few of my side projects
unattended. The thing that kept biting me was confident false task
completions: tests failing, scope drifting, half-baked changes marked
done. Polsia has the same problem in the closed-SaaS shape (see the
Trustpilot reviews). So I built the gate I wished existed and
open-sourced it.

**GeneralStaff** is a local-first dispatcher. It picks a project
from a registry, runs Claude Code (or Codex, or anything you can
invoke from a shell) against a git worktree, runs your test suite,
then runs a second Claude Code, OpenRouter, or local Ollama pass as
a structured-JSON reviewer that checks:

- Did the tests pass?
- Did the diff stay in scope for the task it claimed to finish?
- Did it touch a file in the project's hands-off list?
- Did the task silently fail an implicit requirement?

If any come back false, the cycle rolls back and the bot loses the
worktree. Master is untouched. The only branch the bot ever writes
to is `bot/work` on your own git remote. Every prompt, response,
and diff lands in a `PROGRESS.jsonl` audit log inside your repo.
You can read what the bot tried and what got rejected.

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
cost), merges to master if verified, rolls back if not. It chains
cycles until the budget is hit or the queue drains. Shared state
lives in `state/<project>/` inside the GeneralStaff repo; it never
touches the managed project's working tree.

### Numbers from the repo itself

GeneralStaff runs as its own first project. I built v0.1.0 from
scaffold in 4 days using itself. The verification gate rejected 19
of its own proposed diffs out of 210 reviewer verdicts (~9%). Real
catches: it tried to modify `src/safety.ts`, `src/reviewer.ts`, and
`src/prompts/` at different points and got blocked each time. You
don't have to trust the claim. Grep
`'"verdict":"verification_failed"'` in
`state/generalstaff/PROGRESS.jsonl` and count.

### Install

One-liner on macOS/Linux:

    curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash

PowerShell on Windows:

    irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex

Auto-installs bun if you don't have it, zero root, writes only to
`./GeneralStaff/`. AGPL-3.0.

### Repo

**https://github.com/lerugray/generalstaff**

README has the architecture, Hard Rules, dogfood numbers, and
roadmap. Phase 6 (local web dashboard) is next. Mockup at
`web/index.html` previews the layout.

Happy to answer questions about the verification gate, the reviewer
provider routing, or why the hands-off list is enforced at the
filesystem layer rather than at the reviewer's judgment.

---

## Likely questions and drafted answers (keep in your notes)

**Q: How is this different from setting up a cron + `claude -p` loop?**
That's where I started. The difference: the gate, the hands-off
list, the audit log. A naive `claude -p` loop trusts the agent to
report its own status. Under scope drift, the agent won't. The gate
cross-checks the diff against the task and the hands-off paths.
Cron plus naive loop got me into the mess this is the answer to.

**Q: Can the reviewer be prompt-injected?**
The reviewer runs in its own Claude Code process with a locked-down
tool set: Read, Bash, Grep, Glob. No Edit, no Write. Its output is
parsed as JSON via `JSON.parse` with explicit shape validation. A
malicious diff can't persuade the reviewer to write files. A
malformed response fails safe to `verification_failed`. The
cross-check step in `src/cycle.ts` re-derives hands-off violations
from the raw diff, so a lying reviewer can't bless a bad diff.

**Q: Does it work on Windows?**
Yes. All dogfood cycles ran on Windows. The pre-launch security
audit caught a Windows-specific case-insensitive hands-off bypass,
and that's fixed in v0.1.0.

**Q: What models have you tested?**
Claude Code as engineer. Claude via `claude -p`, OpenRouter Qwen3
Coder (~$0.02/session, default for unattended), and Ollama Qwen3 8B
(free, offline) as reviewers. Engineer is Claude-specific for now;
reviewer is pluggable.

**Q: Any plans for a hosted version?**
No. Hard Rule 10 is local-first. No SaaS tier, no managed offering.
The repo is the product.
