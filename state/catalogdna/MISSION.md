# catalogdna — Mission (GeneralStaff context)

catalogdna is a vinyl record cataloging and pricing tool with a mature
autonomous bot infrastructure. It has its own CLAUDE-AUTONOMOUS.md
protocol, Phase A/B task framework, git worktree isolation, heartbeat
publishing, and chrome-review loops.

GeneralStaff wraps catalogdna's existing `run_bot.sh` — it does NOT
replace the per-project bot. GeneralStaff adds:

1. **Independent verification gate** — runs pytest+ruff externally
2. **Scope-match Reviewer** — fresh claude -p confirms diff matches claims
3. **Open audit log** — PROGRESS.jsonl with full trail

## Bot behavior inherited from catalogdna

- Bot reads `bot_tasks.md` for P0-P3 prioritized work
- Bot uses `.bot-worktree` for isolated execution
- Bot writes `bot_status.md` with current task state
- Bot publishes heartbeat sentinels during long runs
- Bot follows CLAUDE-AUTONOMOUS.md for all decisions

## What GeneralStaff controls

- When to start a cycle (dispatcher picker)
- Whether to chain another cycle (work detection + budget check)
- Whether the cycle's output is verified (verification gate)
- Whether the claimed work matches the diff (Reviewer agent)
- Audit trail of all the above (PROGRESS.jsonl)

## What GeneralStaff does NOT control

- What task the bot picks (catalogdna's own protocol)
- How the bot executes (catalogdna's own CLAUDE-AUTONOMOUS.md)
- What the bot commits (catalogdna's own git workflow)
