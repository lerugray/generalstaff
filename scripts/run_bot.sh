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

# --- Run autonomous bot ---
echo ""
echo "Launching autonomous claude -p in worktree..."
echo ""

claude -p "You are an autonomous engineering bot working on the GeneralStaff project.

## Your environment
You are working in a git worktree on the bot/work branch. The main
working tree is on master and may be in use by a human. Do NOT touch
the main working tree — work only in this directory.

## Your task
Read state/generalstaff/tasks.json and pick the highest-priority
unfinished task (status: 'pending', lowest priority number first;
among same-priority tasks, lowest gs-NNN numeric suffix first). Work
on it, run tests (bun test && bun x tsc --noEmit) to verify your
changes, and commit when tests pass.

## Rules
- Work ONLY on the task you pick. No scope creep.
- Run tests before committing. If tests fail, fix them or abandon the task.
- Commit with a clear message describing what you did.
- Do not modify files in the hands-off list (see CLAUDE.md for the list).
- If you can't complete the task, write a note explaining why and move on.
- Budget: ${BUDGET_MINUTES} minutes. Stop before the budget runs out.
- After committing, update the task status in state/generalstaff/tasks.json." \
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \
  --dangerously-skip-permissions \
  --mcp-config '{"mcpServers":{}}' \
  --strict-mcp-config \
  --output-format text

echo ""
echo "Bot finished. Exit code: $?"
echo "Ended: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
