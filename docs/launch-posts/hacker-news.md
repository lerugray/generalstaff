# Hacker News — Show HN draft

**Status:** Draft 2, 2026-04-20. Revised after the 2026-04-19
r/claudecode post flopped at 800 views / 1 downvote / 0 comments
(see `r-claudecode.md` — the "improved Polsia" framing was the
diagnostic signal: competitor-comparison in the title fails when the
competitor isn't salient to the reader).

**Target site:** news.ycombinator.com — Show HN.
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
2. **Show HN: A dispatcher for Claude Code that rolls back its own bad diffs**
3. **Show HN: GeneralStaff – verification gate for autonomous coding agents**

Recommendation: **#1**. Local-first is the differentiator that'll pull
HN readers skeptical of SaaS agent platforms. #2 is sharper on the
architecture angle if you want to foreground the anti-slop story. #3
is shortest but leans on "verification gate" doing more work than a
cold reader will give it.

**Do NOT** use a Polsia-comparison title. The r/claudecode post died
on that exact framing: naming a competitor the reader hasn't heard
of buries the thing you built under a question about them.

---

## URL

`https://github.com/lerugray/generalstaff`

---

## First comment (OP framing)

GeneralStaff runs Claude Code agents across your local projects with
a verification gate the agent cannot prompt around. The gate is code,
not instructions. Tests fail, empty diff, hands-off violation: cycle
rolls back and nothing reaches master. Every prompt, response, tool
call, and diff lands in a `PROGRESS.jsonl` file inside your repo.

1,628 passing tests across 48 files. 8.6% self-rejection rate on
proposed diffs (20 of 233 reviewer verdicts came back
`verification_failed`). The repo is registered as its own first
managed project, so the audit log contains every cycle where the
gate rejected a bad diff. You don't have to trust the claim. Grep
the log.

Three things I couldn't find in one package:

1. **Built under its own gate.** The repo went from scaffold to
   v0.1.0 in four days, mostly autonomous, under the same
   verification gate it ships with. Every cycle is in
   `PROGRESS.jsonl`, including the rejections with real hands-off
   violations on `src/safety.ts`, `src/reviewer.ts`, and
   `src/prompts/`. Closed-SaaS agent tools can't show you the
   cycles they got wrong. This one can.

2. **The verification gate is Boolean.** Tests pass or they don't.
   A cross-check against the raw diff catches scope drift, not the
   reviewer's judgment. Hands-off matches happen on the filesystem
   path. The agent can ignore what you wrote in the prompt. It
   can't ignore a failing test.

3. **Local-first, BYOK, open audit log.** Your code never leaves
   your machine. Your LLM API key stays in your env. The dispatcher
   pushes only to `bot/work` on your own git remote. There is no
   GeneralStaff server. `git clone` is the install; `git pull` is
   the update. The audit log is a plain text file in your repo.

I built this because every autonomous agent tool shares one failure
mode: confident false task completions. Put the gate in the system,
not in the prompt. The Hammerstein framing (industrious without
judgment is worse than lazy without judgment because the damage
compounds) is in the README if you want the longer argument.

Requirements: Bun 1.2+, git, and either Claude Code, an OpenRouter
account, or a local Ollama install. One-line installer for macOS,
Linux, Windows. AGPL-3.0.

Feedback welcome, especially from people running bot loops in
production. I expect there are three or four things I haven't
thought of yet.

---

## Pre-post checklist

- [x] **Numbers fresh (2026-04-20 evening).** Re-grepped
      `state/generalstaff/PROGRESS.jsonl`: 211 verified + 20
      `verification_failed` + 2 `verified_weak` = 233 reviewer
      verdicts, 8.6% self-rejection. Tests: 1,628 passing across
      48 files (`bun test` local). Re-check within 24 hours of
      posting; rate has held 8.6-9.1% since 2026-04-17.
- [ ] **Front page scan.** Check HN front page 30 minutes before
      posting. If it's saturated with Anthropic/OpenAI news, wait a
      day — your angle gets eaten.
- [ ] **Two friends briefed.** Not to upvote — to ask a
      *substantive* technical question within the first 60 minutes
      if the thread is quiet. Good seed questions: the reviewer
      prompt shape, the hands-off-list semantics, how parallel
      mode avoids reviewer-stampede race conditions. The difference
      between "died at 8 points" and "caught fire" is the first
      real comment, not the first vote.
- [ ] **Day + window.** Tuesday or Wednesday, 9-10am ET. Thursday
      is acceptable. Avoid Monday (post-weekend cleanup noise) and
      Friday afternoon onward.

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
- **"Just another Claude Code wrapper" dismissal is the most likely
  failure mode.** If it lands, the correct counter is the
  `PROGRESS.jsonl` evidence, not a rebuttal in abstract. Paste the
  grep command someone else could run in 30 seconds.
- **"Built in 4 days" will provoke "obviously AI-written" accusations.**
  Lean in. "Yes, that's the point — it was built under the same
  verification gate it ships with. The cycles are in the log." Don't
  get defensive.
- **Critical: don't claim zero false negatives.** The verification
  gate is good, not perfect. 9% self-rejection is the observed
  rate, and some of those were silent failures the reviewer
  caught, which implies there's a base rate the reviewer missed.
  Honesty scales; over-claiming doesn't.
