# GeneralStaff Quickstart

**Status:** v0.8.0+. Setup is usually about five minutes; a first real cycle
often takes 10–60+ minutes depending on the provider, model, and project.
**Audience:** new users wanting a working dispatcher pointed at their own project. Read [`README.md`](README.md) first for what GeneralStaff is and why it exists.

---

## 1. Prerequisites

- **Bun** 1.3.0+ ([install](https://bun.sh)). Used for everything — runtime, test runner, package manager.
- **Git** with your project on a branch you're willing to let the bot modify (the bot writes to `bot/work`, never to `master`).
- **An LLM provider key.** One of:
  - Anthropic API key (BYOK), OR
  - Claude Pro / Max subscription (the `claude` provider auto-detects Claude Code's existing token), OR
  - OpenRouter key (works with most models), OR
  - Aider with a supported provider.

GeneralStaff is BYOK. You pay your provider directly. There is no GeneralStaff platform fee.

## 2. Install

```bash
git clone https://github.com/lerugray/generalstaff.git
cd generalstaff
bun install
./install.sh        # writes `gs` + `generalstaff` shims and offers to update PATH
```

Windows users: run `install.ps1` instead. Both scripts do the same thing — make `gs` available on PATH.

## 3. Register your first project

```bash
gs welcome
```

This is the conversational first-run wizard. It asks you ~5 questions (which provider, where your project lives, what verification command to run, what files are off-limits) and writes `projects.yaml` for you. Skip the dry-run cycle if you want to inspect the config before firing.

If you'd rather edit by hand, copy `projects.yaml.example` and follow the inline comments.

**The `verification_command` field is the load-bearing one.** It's what the gate runs to decide whether a cycle passed. For a TypeScript project that's usually `bun test && bun x tsc --noEmit`. For something else, whatever you'd run before believing a change works.

## 4. Run a cycle

```bash
gs cycle
```

Sequential single-cycle. The dispatcher:

1. Picks one project (the one with the most pending work, modulo the picker's heuristics).
2. Spawns the engineer (Claude / Aider / Codex per your config) in `.bot-worktree/` on a `bot/work` branch.
3. Waits for the engineer to claim a task and produce a diff.
4. Runs your `verification_command`. If it fails, the cycle is rolled back.
5. Runs the reviewer (a separate model that checks the diff against the task description and the hands-off list).
6. If both gate and reviewer pass, the commit lands on `bot/work`. Your `master` is untouched until you merge.

For a longer session, `gs session` runs cycles until budget / weak-streak / no-work conditions stop it. See `gs --help` for all options.

## 5. Inspect the audit log

```bash
cat state/<project_id>/PROGRESS.jsonl
```

Every prompt, response, tool call, and diff lands here. JSONL = one JSON object per line, grep-friendly.

The verdicts you'll see:

| Verdict | Meaning |
|---|---|
| `verified` | Tests pass, diff non-empty, reviewer confirms scope match. Commit landed on `bot/work`. |
| `verified_weak` | Verification skipped because the diff was empty or the engineer reported the task already done. No commit, no progress. Multiple in a row trip the weak-streak circuit breaker. |
| `verification_failed` | Tests failed, or hands-off violation, or reviewer rejected the diff. Cycle rolled back. |

To see only the failures:

```bash
grep '"verdict":"verification_failed"' state/<project_id>/PROGRESS.jsonl
```

This is the bug report. If you file an issue, include the relevant cycle.

## 6. Merge what the bot did

```bash
git checkout master
git merge bot/work
git push
```

The bot never touches `master`. You decide when (and whether) to integrate the work. If you don't like a cycle, `git branch -D bot/work` and the bot will start fresh next session.

---

## Troubleshooting

- **`gs: command not found`** — the `install.sh` shim went somewhere not on PATH. Run `which gs` in a fresh shell; if empty, add `~/.local/bin` to PATH or run `bun src/cli.ts <args>` from the repo dir.
- **Cycle ends with `weak-streak`** — the dispatcher hit 3 consecutive empty-diff cycles and stopped to prevent a runaway. Run `gs inventory-audit` to see what tasks are actually pickable; usually the queue is starved.
- **Engineer asks for an API key** — check your provider's auth path. For Anthropic, `ANTHROPIC_API_KEY` env var or `claude` CLI auth. For OpenRouter, `OPENROUTER_API_KEY`. For aider, see aider's own docs.
- **`verification_command` failed but the diff looks fine** — your tests probably need an env var or working-dir setup the bot subprocess doesn't have. Run the same command manually in `.bot-worktree/` to reproduce.

## Where to go next

- [`CHANGELOG.md`](CHANGELOG.md) — what's new in this version.
- [`AGENTS.md`](AGENTS.md) — agent-config standard adopted by this repo (also Cursor / Aider / Codex / Zed).
- [`SECURITY.md`](SECURITY.md) — key storage, OS-level recommendations, threat model.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — PR process, what's off-limits, how to file issues.
- [`docs/conventions/roadmap.md`](docs/conventions/roadmap.md) — phased autonomous progression (`ROADMAP.yaml` + `gs phase` command, new in v0.3.0).
- [`docs/provider-config-format.md`](docs/provider-config-format.md) — provider routing for non-reviewer roles (digest, summaries, classifiers).
- [`docs/integrations/basecamp.md`](docs/integrations/basecamp.md) — Basecamp 4 integration if you want GS-managed projects to read Basecamp state.
