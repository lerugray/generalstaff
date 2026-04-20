// GeneralStaff — aider engineer provider (gs-270, Phase 7)
//
// Generates the full bash command that runs one engineer cycle using aider
// + OpenRouter (Qwen3 Coder by default) as the alternative to `claude -p`.
// The generated command mirrors the shape of a per-project
// engineer_command.sh: set up the bot/work worktree, install deps
// best-effort, invoke the provider CLI with a task-picking prompt, exit.
// The dispatcher (cycle.ts) captures the git diff, runs verification, and
// runs the reviewer afterwards — provider-agnostic, same as the claude path.
//
// Hard Rule 8 (BYOK): OPENROUTER_API_KEY must be present in the process
// env; aider reads it natively. No key is embedded here.

import type { ProjectConfig, CycleCreativeContext } from "../types";

// OpenRouter's Qwen 3.6 Plus — newer general-purpose flagship (released
// 2026-04-02, ~$0.325/$1.95 per M tokens). The gs-277 benchmark
// (docs/internal/PHASE-7-BENCHMARK-2026-04-20.md) ran this model
// against 10 replayed gamr tasks and got 8/10 = 80% verified,
// clearing the 70% acceptance bar. The original default
// `openrouter/qwen/qwen3-coder-plus` had gotten only 50% on the same
// set — qwen3.6-plus reliably handles multi-file React component
// scaffolding that qwen3-coder-plus couldn't, at the cost of ~5×
// slower cycles (mean 508s vs 107s).
//
// Per-token pricing is actually ~50% cheaper on qwen3.6-plus than
// qwen3-coder-plus, so the longer cycles roughly wash out to similar
// OpenRouter spend per cycle. Projects that want faster iteration
// with weaker quality can override per-project via `engineer_model`
// or per-task via `task.engineer_model`.
export const DEFAULT_AIDER_MODEL = "openrouter/qwen/qwen3.6-plus";

// Shell-quote a string for use inside bash single quotes. Single-quoting
// is the only shell escape that has no surprises — the only char to worry
// about is the single quote itself, which we break out of and re-enter.
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Build the prompt aider sees as its --message. Mirrors the shape of the
// claude engineer prompt in per-project engineer_command.sh files: task
// picking instructions, what-can/can't-do, verification gate, budget.
// Generic across projects — no per-project tuning yet. If benchmark shows
// quality gaps we can add per-project prompt overrides in a follow-up.
//
// gs-279: when `context.isCreative` is true, the prompt is reshaped for
// creative work: voice-reference preamble first, drafts-only output
// instructions, no reviewer gate warning, no "pick any algorithmic task"
// framing (RULE-RELAXATION-2026-04-20 guardrail 5 says taste calls stay
// with the human even inside creative work).
export function buildAiderPrompt(
  project: ProjectConfig,
  context?: CycleCreativeContext,
): string {
  const effectiveBranch = context?.effectiveBranch ?? project.branch;
  const handsOffList = project.hands_off.map((h) => `  - ${h}`).join("\n");

  if (context?.isCreative) {
    const voiceRefBlock =
      context.voiceReferencePaths.length > 0
        ? context.voiceReferencePaths
            .map((p) => `  - ${p}`)
            .join("\n")
        : "  (no voice references configured — draft in a neutral technical register)";
    return `You are an autonomous drafting bot working on the ${project.id} project.

## Your environment
You are in a git worktree on the ${effectiveBranch} branch (separate from
the main bot/work branch to keep creative drafts from contaminating
correctness-work SHAs). The main working tree is on master and may be
in use by a human. Work only in this directory.

## This is a CREATIVE_WORK cycle
You are drafting prose, not writing code that needs to pass tests. Human
review is the gate for this cycle — you draft, the human edits, the
human publishes. Do NOT commit anything to the main README, docs, or
user-facing surfaces directly. Drafts land in the ${context.draftsDir}
directory at the project root.

## Before drafting — calibrate voice
Read these files first to calibrate your voice to the project owner's
own writing. Order matters; read top-to-bottom.

${voiceRefBlock}

Match the register, cadence, sentence length, and idiom of those
references. Do not write in LLM default voice (no "unleash", no
"revolutionize", no em-dash-heavy throat-clearing, no marketing
engagement-bait verbs).

## Your task
Read state/${project.id}/tasks.json and pick the highest-priority
unfinished task with \`creative: true\` (status: 'pending', lowest
priority number first; lowest id among ties). Work on exactly that
task — draft only what the task's brief names.

## What you can do
- Create / modify files inside ${context.draftsDir}.
- Read voice-reference files listed above (outside ${context.draftsDir}).
- Run the verification command (if any): ${project.verification_command}
- Commit with a message describing the draft you produced.
- Mark the task done via the GeneralStaff CLI — do NOT line-edit
  state/${project.id}/tasks.json. Line-oriented edits have corrupted the
  JSON structure on multiple occasions (dropped commas between sibling
  objects, 2026-04-20). Use:
    bun "$GENERALSTAFF_ROOT/src/cli.ts" task done --project=${project.id} --task=<task-id>
  GENERALSTAFF_ROOT is set by the dispatcher. If the CLI errors, fall back
  to opening GENERALSTAFF_ROOT/state/${project.id}/tasks.json, parsing as
  JSON, mutating status to 'done', writing back with 2-space indent.
  Never line-edit tasks.json.

## What you must NOT do
- Modify any file matching a pattern in this hands_off list:
${handsOffList}
- Publish drafts to the main README, docs, blog, or any user-facing
  surface — drafts always land in ${context.draftsDir} and wait for
  human review.
- Invent the brief. If the task says "draft a 300-word README section
  explaining X", you write that exact thing; you don't pivot to "here's
  a tweet instead" or "let me also write a landing page". One task,
  one deliverable.
- Post to any external surface (Twitter, HN, Reddit, the project's
  own site) — those remain manual actions the human takes after
  reviewing drafts.

## Budget
You have ${project.cycle_budget_minutes} minutes total. After
committing the draft, stop — the dispatcher starts a fresh cycle
for the next task.`;
  }

  return `You are an autonomous engineering bot working on the ${project.id} project.

## Your environment
You are in a git worktree on the ${effectiveBranch} branch. The main working
tree is on master and may be in use by a human. Work only in this directory.

## Your task
Read state/${project.id}/tasks.json and pick the highest-priority unfinished
task (status: 'pending', lowest priority number first; among same-priority
tasks, lowest id first). Work on exactly that task — no scope creep.

## What you can do
- Add, modify, or delete files at the paths the task explicitly names.
- Add test files that support the claimed work.
- Run the verification command: ${project.verification_command}
- Commit with a message describing the task you completed.
- Mark the task done via the GeneralStaff CLI — do NOT line-edit
  state/${project.id}/tasks.json. Line-oriented edits have corrupted the
  JSON structure on multiple occasions (dropped commas between sibling
  objects, 2026-04-20). Use:
    bun "$GENERALSTAFF_ROOT/src/cli.ts" task done --project=${project.id} --task=<task-id>
  GENERALSTAFF_ROOT is set by the dispatcher. If the CLI errors, fall back
  to opening GENERALSTAFF_ROOT/state/${project.id}/tasks.json, parsing as
  JSON, mutating status to 'done', writing back with 2-space indent.
  Never line-edit tasks.json.

## What you must NOT do
- Modify any file matching a pattern in this hands_off list:
${handsOffList}
- Invent product features or write user-facing copy.
- Pick algorithms (matching, ranking, etc.) — those are reserved for the
  human. If a task asks for an algorithmic decision, abandon the task and
  write a short note explaining why.

## Verification gate
Tests must pass under \`${project.verification_command}\` before commit.
If they don't pass, fix or abandon — never commit failing tests.

## Budget
You have ${project.cycle_budget_minutes} minutes total. After committing
one task, stop — the dispatcher starts a fresh cycle for the next task.`;
}

// Build the bash command that runs one aider engineer cycle. Does worktree
// setup inline (same shape as engineer_command.sh) so projects using
// engineer_provider: aider don't need to author a per-project wrapper.
//
// gs-279: when `context.isCreative` is true, the worktree is set up on
// context.effectiveBranch (typically project.creative_work_branch) instead
// of project.branch, and the generated prompt is the creative variant
// that prepends voice-reference calibration instructions.
export function buildAiderCommand(
  project: ProjectConfig,
  context?: CycleCreativeContext,
): string {
  const model = project.engineer_model ?? DEFAULT_AIDER_MODEL;
  const prompt = buildAiderPrompt(project, context);
  const effectiveBranch = context?.effectiveBranch ?? project.branch;

  // Shell-escape every value that crosses the bash boundary. set -euo
  // pipefail at the top surfaces errors early; the dispatcher's timeout
  // (cycle_budget_minutes + 5) is the external budget bound.
  const qModel = shellSingleQuote(model);
  const qBranch = shellSingleQuote(effectiveBranch);
  const qPrompt = shellSingleQuote(prompt);
  const qTestCmd = shellSingleQuote(project.verification_command);
  const qProjectId = shellSingleQuote(project.id);

  return `set -euo pipefail

# Force UTF-8 in the Python interpreter aider runs under. Without
# this, aider's "rich" library crashes with UnicodeEncodeError on
# Windows (Git Bash / cp1252 console) the first time the model emits
# a non-ASCII character in aider's status output — ≥, ✓, █, etc. —
# which dumps a Python traceback and kills the subprocess with exit
# code 1. Discovered during the gs-272 benchmark run: 3 of 10 tasks
# failed for exactly this reason before the fix. Safe on Linux/macOS
# (where the default is usually already utf-8) so it's set
# unconditionally rather than platform-gated.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

BUDGET=${project.cycle_budget_minutes}
PROJECT_ROOT="$PWD"
WORKTREE_DIR="$PROJECT_ROOT/.bot-worktree"
BRANCH=${qBranch}

echo "=== aider engineer (project=${qProjectId}) ==="
echo "Model: ${qModel}"
echo "Budget: \${BUDGET} min"
echo "Worktree: \$WORKTREE_DIR"
echo "Started: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Ensure bot/work branch exists
if ! git -C "\$PROJECT_ROOT" rev-parse --verify "\$BRANCH" >/dev/null 2>&1; then
  echo "Creating branch \$BRANCH from master..."
  git -C "\$PROJECT_ROOT" branch "\$BRANCH" master
fi

# Prune + remove stale worktree
git -C "\$PROJECT_ROOT" worktree prune 2>/dev/null || true
if [ -d "\$WORKTREE_DIR" ]; then
  echo "Stale worktree found — removing..."
  git -C "\$PROJECT_ROOT" worktree remove "\$WORKTREE_DIR" --force 2>/dev/null || true
  rm -rf "\$WORKTREE_DIR" 2>/dev/null || true
fi

echo "Creating worktree at \$WORKTREE_DIR on \$BRANCH..."
git -C "\$PROJECT_ROOT" worktree add "\$WORKTREE_DIR" "\$BRANCH"

cd "\$WORKTREE_DIR"

# Best-effort dependency install. Provider-agnostic stack detection — we
# don't hard-fail because aider can still do something useful even on an
# install-skipped tree; the verification gate catches any real break.
if [ -f bun.lock ] || [ -f bun.lockb ]; then
  echo "Detected bun — bun install..."
  bun install --frozen-lockfile 2>/dev/null || bun install || true
elif [ -f package-lock.json ]; then
  echo "Detected npm — npm ci..."
  npm ci 2>/dev/null || npm install || true
elif [ -f pnpm-lock.yaml ]; then
  echo "Detected pnpm — pnpm install..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install || true
elif [ -f requirements.txt ]; then
  echo "Detected pip — pip install..."
  pip install -r requirements.txt 2>/dev/null || true
elif [ -f Cargo.toml ]; then
  echo "Detected cargo — cargo fetch..."
  cargo fetch 2>/dev/null || true
fi

# Aider's OpenRouter path needs OPENROUTER_API_KEY in the env. If it's
# missing, surface that loudly — aider will fail anyway, but a clear
# upstream error saves log-reading time.
if [ -z "\${OPENROUTER_API_KEY:-}" ]; then
  echo "WARNING: OPENROUTER_API_KEY is not set — aider will fail to authenticate." >&2
fi

echo ""
echo "Launching aider..."
echo ""

# --auto-commits: aider commits after each accepted edit block. Simpler
#   than deferring commits to GS because aider picks sensible messages
#   from the diff.
# --yes-always: auto-confirm aider's prompts (file add/remove, etc.).
# --no-analytics: BYOK + local-first; don't phone home.
# --no-stream: disable streaming output — simpler for GS log capture.
# --test-cmd + --auto-test: aider runs verification after edits and
#   iterates if it fails. Mirrors claude -p's "run the test, fix, retry"
#   behavior as closely as aider's agent loop allows.
aider \\
  --model ${qModel} \\
  --edit-format udiff \\
  --yes-always \\
  --auto-commits \\
  --no-analytics \\
  --no-stream \\
  --no-pretty \\
  --no-fancy-input \\
  --test-cmd ${qTestCmd} \\
  --auto-test \\
  --message ${qPrompt}

EXIT=\$?
echo ""
echo "aider finished. Exit: \$EXIT"
echo "Ended: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit \$EXIT`;
}
