# Polsia-alternative — cross-post template

**Status:** Draft 1, 2026-04-19. Ray to revise voice, post when ready.
**Primary target:** r/LocalLLaMA (Polsia-aware audience, local-LLM-
adjacent). Also fits a refresh post on r/ClaudeCode (different angle
than the 2026-04-19 post) or any Polsia-aware discussion thread.
**Also usable at:** alternativeto.net submission, Product Hunt
"alternatives" listing, a Twitter/X thread, replies to Polsia ads.
**Audience:** people already aware of Polsia who are frustrated with
pricing, closed-source opacity, or the confident-false-completion
failure mode (Polsia's #1 Trustpilot complaint as of 2026-04).
**Rules of thumb:**
- Lead with the Polsia hook — that's the whole reason to use THIS
  post versus the generic HN / r/opensource / r/claudecode drafts.
- Keep the body tight. People searching "Polsia alternative" want
  to confirm it exists and scan the architectural differences, not
  read a philosophy essay. ~400 words.
- Repo link goes near the top AND bottom.
- Do NOT attack Polsia's creator. Structural argument only.
- AGPL discussion stays short here (one line). The r/opensource
  draft is the place for the license deep-dive.

---

## Title options (pick one)

1. **Open-source self-hosted alternative to Polsia (v0.1.0, AGPL-3.0, runs entirely on your machine)**
2. **I built a local-first alternative to Polsia — runs on your box, BYOK for the LLM, no SaaS layer**
3. **Polsia alternative: GeneralStaff — open-source, local-first, with a verification gate that can't be prompted around**

Recommendation: **#2** for Reddit (concrete on the specific Polsia
frustrations: SaaS lock-in + opaque cost model). **#1** for
structured listings (alternativeto.net, Product Hunt) where a
neutral descriptor outperforms a personal framing. **#3** for a
refresh post on a sub that already saw the earlier r/claudecode
launch and would downvote a rerun but accept a different angle.

---

## Body draft

Polsia is popular for a reason: unattended coding agents against
your own projects is a genuinely useful workflow. The recurring
complaints cluster around three things: (1) closed-source means
you can't see the reviewer's prompts or verify what the gate
actually checks; (2) the SaaS model sends your code to their
servers; (3) the #1 Trustpilot complaint is confident false task
completions — agents marking work "done" when tests still fail.

I built an open-source local-first version with a different
architecture. **GeneralStaff** is a dispatcher that runs Claude
Code (or any shell-invoked coding agent) against your own
projects, on your own machine, using your own LLM API key.

**Four architectural differences from Polsia:**

1. **Local-first.** Runs entirely on your box. Your code never
   leaves. No account, no server, no telemetry. `git clone` is
   the install; `git pull` is the update. Hard Rule 10 in the
   repo is "no SaaS tier, no managed offering" — this isn't the
   pre-MVP version of a hosted product, it IS the product.

2. **BYOK for the LLM layer.** Your API key stays in your env.
   The reviewer is pluggable between `claude -p` (subscription
   quota), OpenRouter Qwen3 Coder (~$0.02/session, default for
   unattended runs), or local Ollama (free, offline). Route the
   reviewer to the cheap provider and reserve Claude quota for
   the engineer. You see the per-session cost. You choose who
   sees the prompt.

3. **Structural verification gate — not an LLM reviewer's
   judgment.** If the engineer's diff fails your `test &&
   typecheck`, the cycle rolls back. If the diff touches a
   path on your hands-off list, it rolls back. Hands-off
   matches happen on the filesystem path, not on the reviewer's
   interpretation. Boolean exit codes can't be prompted around.
   An LLM reviewer can hallucinate "verified" — that's the exact
   Polsia failure mode; a green test gate cannot.

4. **Open audit log.** Every prompt, response, tool call, and
   diff lands in `PROGRESS.jsonl` inside your repo. Grep it for
   what the bot tried, what got rejected, and why. No opaque
   orchestration. You can reconstruct any cycle from the log.

**Built by itself.** I registered GeneralStaff as its own first
managed project. Scaffold to v0.1.0 in 4 days, 1,441 passing
tests, 9% self-rejection rate on its own proposed diffs (19 of
210 reviewer verdicts came back `verification_failed`). Real
catches: it tried to modify `src/safety.ts`, `src/reviewer.ts`,
and `src/prompts/` at different points and the hands-off list
blocked each. Grep `"verdict":"verification_failed"` in
`state/generalstaff/PROGRESS.jsonl` and count. The audit log is
the proof.

**Stack:** Bun + TypeScript, AGPL-3.0, one runtime dep, cross-
platform (Linux / macOS / Windows). Pre-launch security audit
caught 2 HIGH + 3 MEDIUM findings; all fixed in v0.1.0.

**Install:**

```
curl -fsSL https://raw.githubusercontent.com/lerugray/generalstaff/master/install.sh | bash    # macOS / Linux
irm https://raw.githubusercontent.com/lerugray/generalstaff/master/install.ps1 | iex           # Windows
```

**Repo:** https://github.com/lerugray/generalstaff

Solo dev on a minimum-wage day job — 4 days of nights and
weekends plus a lot of Claude-Code assistance. Feedback welcome,
especially on the verification gate, the provider routing, or
the reviewer's prompt structure. If you're running a bot loop in
production (Polsia or otherwise), I'd want to know what catches
you've seen and what slipped through.

---

## Variants per venue

**For r/LocalLLaMA:** lead with the provider-routing paragraph
(bullet 2). That audience cares about keeping Ollama/OpenRouter
/ Claude traffic balanced; the Polsia comparison is the hook,
the provider flexibility is what they'll stay for.

**For alternativeto.net:** shorten to a 2-3 sentence description
— they have a structured comparison layout that already surfaces
license / platform / language. Link to the repo and let their
template do the rest.

**For a Polsia Facebook ad reply (Ray has done this once):** use
one of bullets 1 + 3 + repo link. Two sentences, no longer.
Ad-reply readers don't scroll.

**For a Twitter/X thread:** split into 4 tweets — hook
(Polsia's false-completion complaint as a structural failure),
bullet 1 (local-first), bullet 3 (verification gate), bullet 4
(audit log) + repo link. Anti-pattern: don't chain more than 4.
Engagement tails off hard past that.

**For Product Hunt:** reframe as "I built this because [specific
use case]" rather than "alternative to X." PH culture prefers
builders-in-public energy over competitive framing. The product
functions identically — just the opening paragraph changes.

---

## Likely questions and drafted answers

**Q: Isn't this just Polsia with a different repo?**
No. Different architecture. Polsia runs on their servers; this
runs on yours. Polsia's reviewer is closed-source; this reviewer
is a Claude Code subprocess with a locked-down tool set, output
parsed as JSON, cross-checked against the raw diff. Polsia's
verification model relies on the LLM self-report; this gate is
a Boolean exit code from YOUR test suite that cannot be argued
with.

**Q: Why would I use this instead of a naive cron + `claude -p`
loop?**
That's where I started. The difference: the structural gate, the
hands-off list, the audit log. A naive loop trusts the agent to
report its own status. Under scope drift, the agent won't. The
gate cross-checks the diff against the task spec and the hands-off
paths at the filesystem layer — the agent can't prompt-engineer
around `exit 1` or a `git worktree` reset.

**Q: Does it actually catch things Polsia misses?**
The architecture guarantees it catches certain failure classes
Polsia cannot catch at all (hands-off violations via path match,
failed verification commands via exit code). Whether it catches
MORE silent-failure cases than Polsia's reviewer in practice is
an empirical question I can't answer without access to Polsia's
logs. What I can show: GeneralStaff's own `PROGRESS.jsonl`
contains 19 rollbacks out of 210 verdicts over 4 days of
self-development, with the specific file paths and task IDs
that triggered each.

**Q: How do I know the "built by itself" numbers aren't
fabricated?**
`PROGRESS.jsonl` is a plain-text append-only file committed into
the repo. Every cycle wrote a line. The `verification_failed`
entries list the specific file paths the bot tried to modify.
The `verified` entries correspond 1:1 with `gs-NNN` commits in
`git log`. Cross-reference.

**Q: What happens if you stop maintaining it?**
Fork it. AGPL-3.0 permits that unconditionally and the
architecture is deliberately simple (one runtime dep, ~17k lines
of TypeScript). Hard Rule 10 commits me to no hosted tier; if a
commercial version ever emerges, it won't come from me.

---

## Anti-patterns to avoid in replies

- Don't attack Polsia's creator personally. Closed-source
  architecture makes the failure mode shippable; the fix is
  structural, not moral.
- Don't claim zero false negatives. 9% observed self-rejection
  is real and specific; there's also a base rate the reviewer
  missed that I can't measure from my own logs alone.
- Don't defend AGPL at length if someone objects. State the
  reasoning once ("copyleft protects the architecture from
  hostile forks into closed SaaS"), link the r/opensource
  draft's deeper reasoning, move on.
- Don't promise roadmap features. Phase 6 (local web dashboard)
  is next; beyond that, don't commit.
- If someone from Polsia shows up: engage respectfully,
  acknowledge their product has value for its audience,
  redirect to the structural comparison. Don't make it personal.
  Don't litigate pricing or their decisions.
- Don't reply to trolls. Downvote-for-the-word-"Polsia"
  comments are statistical noise; feeding them costs more
  signal than it gains.
