# Hacker News — Show HN draft

**Status:** Draft 1, 2026-04-19. Ray to revise voice, post when ready.
**Target subreddit/site:** news.ycombinator.com — Show HN.
**Rules of thumb:**
- HN titles: 50-80 chars, no emoji, no "hype" words, no all-caps,
  no "we". Show HN prefix mandatory.
- First comment from OP is almost always a longer framing paragraph.
- Readers are skeptical-technical. Anti-slop framing will resonate
  (recent agents-md virality is evidence). Avoid SaaS-marketing tone.
- Post when US-morning traffic is warming up (roughly 8-11am ET on a
  weekday). Avoid Saturdays. Never post Sunday night.

---

## Title options (pick one)

1. **Show HN: GeneralStaff – local autonomous coding with a verification gate**
2. **Show HN: GeneralStaff – open-source alternative to Polsia, built by itself**
3. **Show HN: A dispatcher for Claude Code that rolls back its own bad diffs**
4. **Show HN: GeneralStaff – runs Claude Code agents, rolls back slop automatically**

Recommendation: **#1** (local-first is the differentiator that'll pull
HN readers who are skeptical of SaaS agent platforms). Use #2 only if
Polsia is already on HN's radar that week.

---

## URL

`https://github.com/lerugray/generalstaff`

---

## First comment (OP framing)

GeneralStaff is a local-first dispatcher that runs Claude Code (or
any coding agent you can invoke from a shell) across your own
projects. It has a verification gate you can't prompt around. If
the engineer's diff fails your `bun test && bun x tsc --noEmit`, the
cycle rolls back. If the diff touches a path on your hands-off list,
same thing. Every prompt, response, and diff goes into a
`PROGRESS.jsonl` audit log in your repo. Grep it to see what the
bot tried and what got rejected.

Three things it does that I couldn't find in one package:

1. **The verification gate is Boolean.** Tests pass or they don't.
   A cross-check against the raw diff catches scope drift, not the
   reviewer's judgment. Hands-off matches happen on the filesystem
   path. Prompt-engineering can be ignored by the agent. A green
   test gate can't.

2. **Local-first, BYOK, open audit log.** Your code never leaves
   your machine. Your LLM API key stays in your env. The dispatcher
   pushes only to `bot/work` on your own git remote. There is no
   GeneralStaff server. `git clone` is the install; `git pull` is
   the update. The audit log is a plain text file in your repo.

3. **Built by itself.** I registered GeneralStaff as its own first
   managed project. The repo you'd be cloning went from scaffold to
   v0.1.0 in four days, largely by itself, under the same
   verification gate it ships with. 1,441 passing tests. 9%
   self-rejection rate on proposed diffs (190 verified, 19
   rejected, 1 weak in `PROGRESS.jsonl`, with real hands-off
   violations caught on `src/safety.ts`, `src/reviewer.ts`, and
   `src/prompts/`). You don't have to trust the claim. Grep the log.

The architecture is a response to Polsia's #1 Trustpilot complaint:
confident false task completions. Put the gate in the system, not in
the prompt. The Hammerstein framing (industrious without judgment
is worse than lazy without judgment because the damage compounds)
is in the README if you want the longer argument.

Requirements: Bun 1.2+, git, and either Claude Code, an OpenRouter
account, or a local Ollama install. One-line installer for macOS,
Linux, Windows. AGPL-3.0.

Built on nights and weekends while working a minimum-wage day job.
Feedback welcome, especially from people running bot loops in
production. I expect there are three or four things I haven't
thought of yet.

---

## Anti-patterns to avoid in replies

- Don't fight Polsia comparisons in-thread; let the architectural
  contrast speak for itself. Polsia works for people who want it.
  GeneralStaff is for people who don't.
- Don't promise features. Roadmap is in the README; stick to it.
- Don't defend the Hammerstein framing if someone objects to the
  military metaphor — acknowledge the reference tradition is niche
  and point at the functional Kriegspiel mapping table. Don't
  litigate it.
- Don't apologize for the AGPL. It's a deliberate choice (anti-
  extraction posture). Explain once per thread, link the LICENSE,
  move on.
- **Critical: don't claim zero false negatives.** The verification
  gate is good, not perfect. 9% self-rejection is the observed
  rate, and some of those were silent failures the reviewer
  caught — which implies there's a base rate the reviewer
  missed. Honesty scales; over-claiming doesn't.
