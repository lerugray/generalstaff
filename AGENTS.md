# AGENTS.md — generalstaff

> Generated 2026-04-25 via the agents-md-wizard skill (type: infra).
> Update with: `/agents-md-wizard /path/to/generalstaff --update`
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
  dependency. Runs on Windows-native (Git Bash + PowerShell); WSL2 is
  a follow-on, not a target.
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

---

## Revisions

<!-- Update mode appends dated sections below. -->

---

<!-- lean-ctx -->
## lean-ctx

Prefer lean-ctx MCP tools over native equivalents for token savings.
Full rules: @LEAN-CTX.md
<!-- /lean-ctx -->
