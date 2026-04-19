# r/opensource — launch post draft

**Status:** Draft 1, 2026-04-19. Ray to revise voice, post when ready.
**Target subreddit:** r/opensource
**Audience:** OSS-culture-fluent readers. Value AGPL-style copyleft
when it earns its place. Skeptical of anything that smells like
closed-source-with-OSS-marketing. Appreciate specific license
reasoning, self-hosting stories, and anti-vendor-lock-in framing.
Will reject anything that reads as "I open-sourced someone else's
closed product out of spite" — lead with the structural argument,
not the personal one.
**Rules of thumb:**
- Flair: "Show & Tell" or "Promotional" depending on sub rules.
- Include the license prominently (AGPL-3.0 earns respect here).
- The "built by itself" numbers are strong but put the
  open-source-architecture argument first — that's what this sub
  cares about.
- If the sub has a Self-Promotion Saturday rule, check before
  posting.

---

## Title options (pick one)

1. **GeneralStaff: open-source autonomous-engineering dispatcher (AGPL-3.0, local-first, built by itself in 4 days)**
2. **I built an open-source alternative to Polsia in 4 days using itself**
3. **Local-first autonomous-engineering tool with an open audit log, AGPL-3.0, no SaaS tier**
4. **Show r/opensource: a dispatcher for AI coding agents that cannot ship slop because the verification gate is architectural**

Recommendation: **#1** (puts the license + local-first up front,
which is what the sub reads for; the "built by itself in 4 days"
tail gives it a concrete hook without over-promising).

---

## Body draft

I've been running AI coding agents against my side projects
unattended. The thing that kept biting me was confident false task
completions: tests failing but the agent marks the task done anyway,
scope drifting, half-baked changes merged without my noticing.
Polsia is a SaaS product with the same problem plus the twist that
you can't audit or fix it. Their top Trustpilot complaint is false
task completions. The closed-source architecture is what makes
that failure mode possible to ship.

So I built the gate I wished existed and open-sourced it under
AGPL-3.0.

**GeneralStaff** is a local-first dispatcher that runs Claude Code
(or any coding agent you can invoke from a shell) across your own
projects. Its verification gate is Boolean, not prompt-based. Three
things the architecture does that I couldn't find in one package:

1. **The gate is structural.** If the engineer's diff fails your
   project's test command, the cycle rolls back. If the diff
   touches a path on your hands-off list, it rolls back. Hands-off
   matches happen on the filesystem path, not on the reviewer's
   judgment. An LLM reviewer can hallucinate "verified" (it did
   this three times in my own bot runs today); a green test gate
   can't. Every prompt, response, and diff lands in a
   `PROGRESS.jsonl` audit log inside your repo so you can read
   what the bot tried and what got rejected.

2. **Local-first, BYOK, no SaaS tier.** Your code stays on your
   machine. Your LLM API key stays in your env. The bot only
   pushes to `bot/work` on your own git remote. There is no
   GeneralStaff server. `git clone` is the install path;
   `git pull` is the update path. No account, no hosted mode,
   no telemetry. If I get hit by a bus, you fork it and keep
   going. The AGPL-3.0 license guarantees that.

3. **Built by itself.** I registered GeneralStaff as its own
   first managed project. The repo went from scaffold to v0.1.0
   in 4 days, largely by itself, under the same gate it ships
   with. 1,441 passing tests. 9% self-rejection rate on proposed
   diffs: 190 verified, 19 rejected, 1 weak. Grep
   `'"verdict":"verification_failed"'` in
   `state/generalstaff/PROGRESS.jsonl` and count. Real catches:
   it tried to modify `src/safety.ts`, `src/reviewer.ts`, and
   `src/prompts/` at different points and got blocked each time.

**On the license.** AGPL-3.0 is deliberate. If someone takes this,
runs it as a hosted service, and charges per-credit for confident
slop, the users of that service deserve to see the source and have
the option to self-host instead. Copyleft is the tool that makes
that guarantee durable. I don't plan to build a hosted tier
myself; Hard Rule 10 in the repo is "local-first, no SaaS tier, no
managed offering." So the AGPL isn't protecting a revenue stream.
It's protecting the architecture.

**On the Polsia comparison.** Polsia is a closed-source SaaS
version of a related idea. I'm not claiming the creator is wrong
to build it the way they did. I'm claiming the closed-source
architecture is what makes the failure mode (confident false
completions nobody can audit) possible to ship. The fix is
structural, not moral. Open source is the structural answer.

**Stack:** Bun + TypeScript, AGPL-3.0, cross-platform (Windows,
macOS, Linux). One-line installer for each platform. The only
runtime dep is the `yaml` parsing library. A pre-launch security
audit caught 2 HIGH + 3 MEDIUM findings; all fixed in v0.1.0.

**Works alongside:** compatible with the `agents-md`
drop-in-rules-file pattern (separate OSS project). agents-md
tightens the engineer subprocess at the instruction layer;
GeneralStaff catches what slips through at the execution layer.
Use either alone or both.

**Repo:** https://github.com/lerugray/generalstaff

Feedback welcome, especially on the license choice and the
self-hosting story. I'm a solo dev working a minimum-wage day
job; if something about the repo reads as enterprise-astroturfed
I'd want to know so I can fix the voice.

---

## Likely questions and drafted answers (keep in your notes)

**Q: Why AGPL instead of MIT/Apache?**
Because the failure mode this tool is trying to prevent (closed-
source coding-agent-as-a-service with confident slop) is
exactly the thing AGPL was designed to make harder. MIT would
let someone fork this, close-source the fork, wrap it in a
SaaS, and reintroduce the same opacity problem I'm trying to
solve. AGPL makes that specific move unprofitable. If you want
to integrate with a non-AGPL codebase, the repo is also the
install path. Your codebase calls GeneralStaff as a subprocess
via its CLI, which doesn't trigger AGPL's linking clauses.

**Q: What's the exit strategy if you stop maintaining it?**
Fork it. The AGPL-3.0 license permits that unconditionally and
the architecture is deliberately simple (one runtime dep, ~17k
lines of TypeScript). I also committed to Hard Rule 10 in the
repo: no hosted tier. If GeneralStaff ever gets a commercial
arm it won't come from me.

**Q: Is this actually different from Polsia structurally, or
just in licensing?**
Structurally. Polsia runs on their servers; your code goes to
them. GeneralStaff runs on your machine; your code never leaves.
Polsia doesn't expose the reviewer's prompts or responses;
GeneralStaff writes every one to a plain text audit log in your
repo. Polsia's verification model relies on the LLM's
self-report; GeneralStaff's gate is a Boolean exit code from
your own test suite that cannot be argued with. These are
different architectures, not different licensing of the same
architecture.

**Q: How do I know the "built by itself" numbers aren't made up?**
grep in `state/generalstaff/PROGRESS.jsonl` for the specific
verdicts. It's a plain text file. Every cycle in the last 4 days
wrote a line to it. The verification-failed entries list the
specific files the bot tried to modify. The verified entries are
on 179 `gs-XXX` commits across the same period.

**Q: Does this work with agents other than Claude Code?**
The engineer is whatever shell command you configure in
`projects.yaml`. I've only tested Claude Code (the
`--dangerously-skip-permissions` variant) as engineer. The
reviewer layer has first-class support for three providers
(Claude via `claude -p`, OpenRouter Qwen3 Coder, local Ollama),
all configurable per-session or per-env. Adding a new reviewer
provider is ~50 lines; there's a pattern to follow in
`src/reviewer.ts`.

---

## Anti-patterns to avoid in replies

- Don't attack Polsia's creator personally. The structural
  argument is the strong one; the personal argument undermines
  the structural one. If someone in the thread frames it as
  "greed," gently redirect to "closed-source architecture makes
  the failure mode shippable."
- Don't oversell the gate. 9% self-rejection is the observed
  rate. That's 9% of proposed diffs the architecture caught;
  there's also a base rate the reviewer missed. Honesty scales.
- Don't apologize for AGPL. It's a considered choice and
  r/opensource will respect it if you explain the reasoning
  (which the body draft does). If someone pushes back with
  "AGPL scares enterprise users," acknowledge the tradeoff
  and point out that enterprise users aren't the target
  audience for v0.1.0.
- Don't engage with "license wars" in-thread. State your
  reasoning once per sub-thread and move on. Downthread
  debates eat signal.
