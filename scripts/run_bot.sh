#!/usr/bin/env bash
# GeneralStaff bot launcher — worktree-isolated autonomous cycle
#
# Usage: bash scripts/run_bot.sh [budget_minutes]
#
# Creates a git worktree at .bot-worktree on branch bot/work,
# runs claude -p inside it, cleans up on exit. The main working
# tree stays on master untouched — safe to run while Ray is
# interactively editing in the main directory.

set -euo pipefail

BUDGET_MINUTES="${1:-60}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE_DIR="$PROJECT_ROOT/.bot-worktree"
BRANCH="bot/work"

echo "=== GeneralStaff Bot Launcher ==="
echo "Budget: ${BUDGET_MINUTES} min"
echo "Project root: $PROJECT_ROOT"
echo "Worktree: $WORKTREE_DIR"
echo "Branch: $BRANCH"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "================================="

# NOTE: The worktree is intentionally NOT cleaned up here.
# The dispatcher (cycle.ts) manages worktree lifecycle:
#   1. Engineer creates/uses the worktree (this script)
#   2. Dispatcher runs verification IN the worktree
#   3. Dispatcher cleans up the worktree after review
# This ensures verification tests the bot's code, not master.

# --- Ensure bot/work branch exists ---
if ! git -C "$PROJECT_ROOT" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "Creating branch $BRANCH from master..."
  git -C "$PROJECT_ROOT" branch "$BRANCH" master
fi

# --- Create worktree ---
# Prune stale worktree registrations (git tracks worktrees internally
# even after the directory is deleted — on Windows rm can fail silently)
git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true

if [ -d "$WORKTREE_DIR" ]; then
  echo "Stale worktree found — removing..."
  git -C "$PROJECT_ROOT" worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
  rm -rf "$WORKTREE_DIR" 2>/dev/null || true
fi

echo "Creating worktree at $WORKTREE_DIR on $BRANCH..."
git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" "$BRANCH"

# --- Install dependencies in worktree ---
echo "Installing dependencies in worktree..."
cd "$WORKTREE_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install

# --- Repo-structure orientation (feat/repo-context-dispatch) ---
# Best-effort: map the WORKTREE (the actual code the bot edits). The
# helper prints an orientation block on success + non-empty map, and
# prints NOTHING / exits 0 on any failure or timeout. The claude path has
# MCP disabled (--mcp-config '{}'), so a map STRING in the prompt is the
# only way to give it instant structure. An empty REPO_CTX => the prompt
# is dispatched exactly as before this feature existed.
REPO_CTX="$(bash "$PROJECT_ROOT/scripts/gen-repo-context.sh" "$WORKTREE_DIR" 2>/dev/null || true)"

# --- Run autonomous bot ---
echo ""
echo "Launching autonomous claude -p in worktree..."
echo ""

# Build the seed prompt in a shell var so the (possibly empty) repo-map
# orientation can be prepended at the TOP without disturbing the static
# prompt below — which carries the task, the rules (incl. hands_off), and
# the verification step, and stays intact and prominent after the map.
SEED_PROMPT="You are an autonomous engineering bot working on the GeneralStaff project.

## Your environment
You are working in a git worktree on the bot/work branch. The main
working tree is on master and may be in use by a human. Do NOT touch
the main working tree — work only in this directory.

## Your task
Read state/generalstaff/tasks.json and pick the highest-priority
unfinished task (status: 'pending', lowest priority number first;
among same-priority tasks, lowest gs-NNN numeric suffix first). Work
on it and run tests (bun test && bun x tsc --noEmit) to verify your
changes. Then finish the cycle per the 'Finishing the cycle' steps below.

## Rules
- Work ONLY on the task you pick. No scope creep.
- Run tests before committing. If tests fail, fix them or abandon the task.
- Commit with a clear message describing what you did.
- Do not modify files in the hands-off list (see CLAUDE.md for the list).
- If you can't complete the task, write a note explaining why and move on.
- Budget: ${BUDGET_MINUTES} minutes. Stop before the budget runs out.

## Finishing the cycle
Order matters. The dispatcher detects completed work by diffing
state/generalstaff/tasks.json between the start and end of the cycle, so
the 'task done' status change MUST land inside a commit. If you mark the
task done AFTER your final commit, the status change stays uncommitted
and is discarded when the worktree is torn down (observed 2026-04-20).

Do these steps in this order:

1. Mark the task done via the GeneralStaff CLI — do NOT line-edit
   state/generalstaff/tasks.json. Line-oriented edits have corrupted the
   JSON structure on multiple occasions (dropped commas between sibling
   objects, 2026-04-20). The CLI parses, mutates, and writes back a
   well-formed file:

     bun \"\$GENERALSTAFF_ROOT/src/cli.ts\" task done --project=generalstaff --task=<task-id>

   GENERALSTAFF_ROOT is set by the dispatcher. If the CLI itself errors,
   fall back to: read the whole tasks.json, JSON.parse it, set the
   target task's status to 'done', write back with 2-space indent +
   trailing newline. Never do line-by-line edits on tasks.json.

2. Stage everything — your code changes AND the tasks.json status
   change. Stage the whole tree so the state change is never missed:

     git add -A

3. Commit with a clear message describing what you did. Your code and
   the 'done' status change land together in this one commit.

## Form your own plan (no approval needed)
Form a short plan for the task you pick (which files you'll touch, in what
order), then proceed and execute it — you do NOT need anyone to approve
your plan first. The repo-structure orientation (if present above) is a
fast map, not authoritative; verify against the actual files before
editing. The hands-off list and the test-pass requirement above still bind
regardless of your plan."

# Prepend the repo-map orientation (empty => prompt unchanged).
if [ -n "$REPO_CTX" ]; then
  SEED_PROMPT="${REPO_CTX}"$'\n\n'"${SEED_PROMPT}"
fi

claude -p "$SEED_PROMPT" \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  --dangerously-skip-permissions \
  --mcp-config '{"mcpServers":{}}' \
  --strict-mcp-config \
  --output-format text

echo ""
echo "Bot finished. Exit code: $?"
echo "Ended: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
