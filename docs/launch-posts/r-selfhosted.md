# r/selfhosted — launch post draft

**Status:** Draft 1, 2026-04-19. Stop-slop applied on first pass.
Ray to revise voice, post when ready.
**Target subreddit:** r/selfhosted
**Audience:** People who self-host services. They prioritize: no
SaaS dependency, data stays on their hardware, simple install
path, clear runtime deps, self-hosting ergonomics. Less familiar
with Polsia than r/claudecode or r/LocalLLaMA readers. De-emphasize
the Polsia comparison; let the self-hosting story lead.
**Rules of thumb:**
- Flair: likely "Release" or similar. Check the sub's weekly
  pinned rules for self-promotion policy before posting.
- r/selfhosted enforces self-promotion rules strictly. The pitch
  qualifies because GeneralStaff is genuinely self-hostable, not
  SaaS-with-open-core dressing.
- Include resource requirements concretely (Bun runtime, one
  package.json dep, no daemon, no background service).
- Repo link goes near top AND bottom.
- Stop-slop: no em-dashes, no LLM cadence, no hedging adverbs.

---

## Title options (pick one)

1. **GeneralStaff: self-hosted dispatcher for AI coding agents (AGPL-3.0, no SaaS, one runtime dep)**
2. **I built a self-hosted dispatcher for Claude Code. Lives in your own repo, no account, no server.**
3. **Self-hosted local-first orchestrator for autonomous AI coding, AGPL-3.0**

Recommendation: **#2** for r/selfhosted. Concrete, reads like a
builder's release note, puts the self-hosting property first.
**#1** for structured listings (alternativeto.net, a sidebar
roundup). **#3** for longer-post threads where a neutral
descriptor sets context.

---

## Body draft

If you run AI coding agents against your own projects, you've
probably looked at Polsia or a similar SaaS orchestrator. I
built the local-first version.

**GeneralStaff** is a dispatcher that runs Claude Code (or any
shell-invoked coding agent) against your own projects, on your
own machine. No account, no server, no telemetry. `git clone`
installs it. `git pull` updates it. Hard Rule 10 in the repo
says no SaaS tier, no managed offering. This is the product,
not the MVP of a hosted one.

**Install:**

```
curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash    # macOS / Linux
irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex           # Windows
```

Auto-installs Bun if you don't have it. Zero root. Writes only
to `./GeneralStaff/`.

**What runs on your box:**

- The dispatcher (Bun runtime, one package.json dep beyond Bun).
- Claude Code as the engineer subprocess, or any other coding
  CLI you configure in `projects.yaml`.
- A reviewer subprocess: `claude -p`, OpenRouter Qwen3 Coder, or
  local Ollama.
- Project worktrees on your own git remote. The bot only writes
  to `bot/work`, never to master.
- A `PROGRESS.jsonl` audit log inside each managed project's
  repo.

**What doesn't leave your box:**

- Your code.
- Your LLM API key (BYOK; Ollama reviewer means fully offline if
  you want it).
- Your audit log (committed to your own repo, grep as needed).
- Telemetry (none exists).

**Provider routing for self-hosters.** The reviewer runs against
Claude subscription quota, OpenRouter Qwen3 Coder (~$0.02/session),
or local Ollama (free, offline). Route reviewer calls to whichever
fits your budget and latency posture. Reserve Claude quota for
the engineer's heavier work. Configurable per-session via env
vars, per-project via `projects.yaml`.

**Verification gate.** If the engineer's diff fails your project's
test command, the cycle rolls back. If the diff touches a path
on your hands-off list, it rolls back. The dispatcher matches
hands-off paths at the filesystem layer, not through the
reviewer's interpretation. An LLM reviewer can hallucinate
"verified"; a Boolean exit code cannot.

**Built by itself.** I registered GeneralStaff as its own first
managed project. Scaffold to v0.1.0 in 4 days. 1,441 passing
tests. 9% self-rejection rate on its own proposed diffs (19 of
210 reviewer verdicts came back `verification_failed`). Real
catches: the bot tried to modify `src/safety.ts`,
`src/reviewer.ts`, and `src/prompts/` at different points. The
hands-off list blocked each. Grep
`"verdict":"verification_failed"` in
`state/generalstaff/PROGRESS.jsonl` if you want to confirm.

**Stack.** Bun + TypeScript, AGPL-3.0, Linux / macOS / Windows.
Pre-launch security audit caught 2 HIGH + 3 MEDIUM findings. All
fixed in v0.1.0.

**Polsia comparison** if you want it: Polsia runs on their
servers, closed-source reviewer, subscription pricing. This
runs on yours, open reviewer prompts, BYOK. Same workflow,
different architecture.

**Repo:** https://github.com/lerugray/generalstaff

Solo dev, minimum-wage day job, 4 days of nights and weekends
with a lot of Claude-Code assistance. Happy to answer questions
about the verification gate, the provider routing, or the
self-hosting ergonomics.

---

## Likely questions and drafted answers

**Q: What resources does this actually need at runtime?**
Bun (auto-installed if missing), git, and whatever your engineer
CLI needs (typically Claude Code, which needs its own auth).
Reviewer adds either a local Ollama (for fully offline) or one
of two API calls per cycle (Claude or OpenRouter). The dispatcher
itself is a short-lived process per session; there's no daemon,
no systemd unit, no background service. Run it manually, via
cron, or via Task Scheduler. It doesn't care.

**Q: Can I run this fully offline?**
Engineer: yes, if you use a local-CLI engineer (not Claude Code,
which calls Anthropic). Reviewer: yes, with Ollama. The
dispatcher itself has no network I/O beyond git remote pushes
(which go to whatever git remote you configure, including a
local file://).

**Q: How does this compare to a naive `cron + claude -p` setup?**
That's where I started. The difference: the verification gate,
the hands-off list, the audit log. A naive loop trusts the
agent's self-report. Under scope drift, the agent won't report
honestly. The gate cross-checks the diff against the task spec
and the hands-off paths at the filesystem layer. The agent can't
prompt-engineer around `exit 1` or a `git worktree` reset.

**Q: Where does state live? Does it survive a reboot?**
`state/<project>/` inside the GeneralStaff repo, plus
`bot/work` branches on the managed projects' git remotes. No
database, no SQLite file, no IPC socket. Everything is plain
text. A reboot loses nothing. A `git pull` on a different
machine picks up where you left off, assuming you committed and
pushed before switching.

**Q: What about rate limits on the LLM providers?**
BYOK means the rate limits are yours. Configure
`cycle_budget_minutes` per project to cap a single cycle's LLM
spend. Configure `dispatcher.max_parallel_slots` to cap
concurrent reviewer calls (a per-provider semaphore prevents
stampedes on OpenRouter's free tier). You can swap providers
per-session with a CLI flag.

**Q: Is there a web UI?**
Not yet. Phase 6 (a local web dashboard) is the next major
roadmap item. The dispatcher already runs headless; the UI is
a viewer / controller layer on top. Mockup at `web/index.html`
previews the layout.

**Q: What happens if you stop maintaining it?**
Fork it. AGPL-3.0 permits that. The architecture is deliberately
simple (one runtime dep, ~17k lines of TypeScript). Hard Rule 10
in the repo commits me to no hosted tier, so if a commercial
version ever emerges, it won't come from me.

---

## Anti-patterns to avoid in replies

- Don't make the Polsia comparison the main event. Self-hosters
  who don't use Polsia will tune out. Lead with self-hosting
  properties, mention Polsia only if someone asks.
- Don't oversell the verification gate. 9% observed self-
  rejection is the specific number and there's a base rate the
  reviewer missed that I can't measure from my logs alone.
- Don't promise features. Roadmap in README; Phase 6 is the
  next concrete piece.
- Don't argue license choice at length. "Copyleft protects the
  architecture from SaaS forks" is the one-line rationale. Point
  at the r/opensource draft in `docs/launch-posts/` for the
  longer reasoning.
- If someone asks about Docker / Kubernetes / systemd: honest
  answer is the dispatcher is short-lived and doesn't need any
  of those. No Dockerfile yet. If someone wants one, that's a
  PR. Don't commit to shipping one.
- If someone asks why not a `.deb` / `.rpm` / Homebrew tap:
  install script handles it. Packaging is a future nice-to-have,
  not a blocker.
