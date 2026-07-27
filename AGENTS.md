# AGENTS.md — generalstaff

> Generated 2026-04-25 via the agents-md-wizard skill (type: infra).
> Update with: `/agents-md-wizard /path/to/generalstaff --update` — the
> skill is project-scoped at `.claude/skills/agents-md-wizard/`, so it is
> invocable from a Claude Code session opened in THIS repo.
> Staleness-checked 2026-07-27 (see §Revisions).
> Spec: https://agents.md

## 1. What this is

Open-source improvement on the Polsia model — a tool that lets people
easily set up businesses, side-hustles, art projects, or whatever else
they have in mind, run autonomously or with better-organized structure.
Open source and free.

## 2. What this is NOT

- Not a generic SaaS.
- Not "AI-accepted slop" by default — the orchestration discipline
  (hands_off lists, reviewer gate, hard-rule scope discipline) is the
  point.

## 3. Done when

v1.0 ships when at least 5 external users (not the maintainer) have
completed a full bot session against their own project, with feedback
confirming the orchestration was more useful than chaotic. The bar
distinguishes "it installs" from "it actually delivers value."

## 4. What this infrastructure enables

Non-engineers (and engineers) can set up and run AI-driven autonomous
work on their own projects — businesses, SaaS, side-hustles, art
pieces, research, internal tools — without having to hand-build:

- Orchestration (multi-project routing, parallel sessions, scheduling)
- Reviewer logic (verification gate, hands-off discipline, scope rails)
- Multi-project state management (per-project tasks, fleet view)
- Safety rails (rollback on verification failure, explicit hands-off
  paths, hard-rule scope discipline)
- Cross-session communication (Tier 0–4 spawn primitives, mailbox,
  observability)

## 5. Who consumes this

Both humans and bots:

- **Humans** — primarily the operator setting up + steering the work.
- **Bots** — the AI sessions GeneralStaff orchestrates against each
  registered project, plus auxiliary tooling (reviewers, monitors,
  spawned deep-dives).

## 6. What constraints are load-bearing

- **Hardware:** laptop-class dev environment. No cloud infrastructure
  dependency. Cross-platform: Windows-native (Git Bash + PowerShell),
  macOS (bootstrap validated 2026-05-01 on a fresh MacBook via
  `install.sh` + `gs welcome`), Linux. WSL2 is supported on Windows
  but not the primary target.
- **Cost ceiling:** must fit within an Anthropic Max 20 subscription
  for a single operator's daily use. Features that require
  pay-as-you-go API spend, enterprise tiers, or external paid services
  beyond the user's own choice are out of scope by default.
- **Operator skill:** doesn't assume professional engineering
  background. Strategic / product decisions stay with the operator;
  structural / architectural decisions can be delegated to Claude.

## 7. Who runs this long-term

The maintainer, plus any external contributors who emerge.

## 8. Non-goals (reactive pruning log)

<!-- Append here as scope decisions are made during the project's life. -->
- 2026-04-25: Not a generic SaaS — local-first, operator-owned.
- 2026-04-25: Not an "accept-slop-by-default" framework — the
  reviewer gate + hands_off discipline are load-bearing.
- 2026-04-25: Not a Linux-native or macOS-native target — Windows-
  first, WSL2 secondary.
- 2026-04-25: Not pay-as-you-go API spend dependent — Max 20
  subscription is the ceiling.
- 2026-05-01: Cross-platform amended in. Fresh-Mac dogfood pass
  validated install + bootstrap + wizard end-to-end; install.sh
  shim, wizard subscription-auth, and model-picker fixes shipped
  same evening. Supersedes the 2026-04-25 "Windows-first" framing
  for the OS dimension; the Max-subscription ceiling stays.

---

## 9. Agent conduct (any coding agent working in this repo)

Added 2026-06-12, adapted from the FerroxLabs agents-md pattern after a
fleet review found these three clauses missing from the house files.

1. **Disagree before doing the work when the premise is wrong.** If the
   instruction rests on a false premise (a file that doesn't exist, a
   behavior the code doesn't have, a constraint that isn't real), say so
   and stop — don't implement against the broken premise. Scope rails
   protect *what* you touch; this protects *why*.
2. **Two failed corrections = stop.** If the operator has corrected the
   same issue twice and your third attempt would be another variation on
   the same guess, stop and ask for a sharper prompt or a reset instead
   of thrashing. Burned context is worse than a restart.
3. **Project learnings** (compact correction ledger — one line per
   correction, newest first; distinct from the dated narrative in
   Revisions):
   <!-- Append one-liners here as corrections land. -->
   - 2026-07-27: The recurring failure here is **doc drift, not code rot**
     — this project moves faster than its own maps. When you learn
     something that invalidates a doc, fix the doc in the same turn, and
     edit the wrong claim itself rather than stapling a correction on top
     of it. A "superseded" banner above a sentence that still asserts the
     old thing leaves two live instructions, and the next reader picks
     whichever one they hit first.

---

## Revisions

<!-- Update mode appends dated sections below. -->

### 2026-07-27 — staleness check (no rewrite needed)

Checked end-to-end after the private overlay (`generalstaff-private/AGENTS.md`)
was found to be describing an April state months out of date. **This file
held up.** Recorded here so the next session does not re-audit it:

- §3's v1.0 bar (5 external users completing a full bot session against
  their own project) is a stable criterion, not a status claim — kept.
- §6's constraints are current: the cross-platform amendment landed
  2026-05-01, and the Max-20x/BYOK cost ceiling still describes what this
  framework may assume of a user.
- §8 is an append-only dated log and is working as designed.
- Header updated to say where the wizard skill actually lives — it is
  project-scoped to this repo, so it does not appear in the skill list of
  a session opened in the sibling private repo, which reads exactly like
  the skill having been deleted.

The private overlay took the real work; its own §Revisions carries that
detail.

---
