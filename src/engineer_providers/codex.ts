// GeneralStaff — codex engineer provider (2026-07-29, experimental)
//
// Generates the full bash command that runs one engineer cycle using OpenAI's
// Codex CLI as an alternative to `claude -p` / aider / grok. The generated
// command mirrors buildGrokCommand's shape: set up the bot/work worktree,
// install deps best-effort, run the provider CLI headlessly with a task
// prompt, exit with its code. The dispatcher (cycle.ts) captures the git
// diff, runs verification, and runs the reviewer afterwards — provider-
// agnostic.
//
// Auth model matches grok: the Codex CLI is backed by the operator's own
// ChatGPT / Codex subscription via `codex login`, NOT an API key shipped by
// GeneralStaff. Hard Rule 8 BYOK is satisfied by the operator's own logged-
// in CLI. Under `-s workspace-write`, Codex can edit workspace files but
// cannot write `.git` — commit handling stays on the GS side (same as every
// other provider path after the engineer exits).

import type { ProjectConfig, CycleCreativeContext, GreenfieldTask } from "../types";
import { buildAiderPrompt } from "./aider";
import { GENERALSTAFF_TASK_CLAIM_PREFIX } from "../prompts/engineer_claim";

// Shell-quote a string for use inside bash single quotes (the only escape
// with no surprises). Mirrors grok.ts / aider.ts; duplicated to keep
// provider modules independent.
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Build the bash command that runs one Codex engineer cycle. Reuses the
// provider-agnostic engineer prompt (buildAiderPrompt). Worktree setup,
// claim echo, dep install, and repo-context orientation match the grok path.
//
// Model policy: omit `-m` when engineer_model is unset so the operator's
// Codex default (ChatGPT-sub gpt-5.6-sol family) applies. Passing bare
// gpt-5.6 tags under ChatGPT auth can 400 — don't invent a DEFAULT.
export function buildCodexCommand(
  project: ProjectConfig,
  context?: CycleCreativeContext,
  nextTask?: GreenfieldTask,
): string {
  const model = project.engineer_model;
  const prompt = buildAiderPrompt(project, context, nextTask);
  const effectiveBranch = context?.effectiveBranch ?? project.branch;

  const claimLine =
    nextTask?.id != null
      ? `${GENERALSTAFF_TASK_CLAIM_PREFIX}${JSON.stringify({
          attempted_task_id: nextTask.id,
        })}`
      : "";
  const claimEchoBlock =
    nextTask?.id != null ? `echo ${shellSingleQuote(claimLine)}\n` : "";

  const qBranch = shellSingleQuote(effectiveBranch);
  const qPrompt = shellSingleQuote(prompt);
  const qProjectId = shellSingleQuote(project.id);
  const modelFlag =
    model != null && model !== ""
      ? ` \\\n  -m ${shellSingleQuote(model)}`
      : "";
  const modelEcho =
    model != null && model !== ""
      ? `echo "Model: ${shellSingleQuote(model)}"`
      : `echo "Model: (Codex CLI default)"`;

  if (!Number.isInteger(project.cycle_budget_minutes)) {
    throw new Error(
      `project ${project.id}: cycle_budget_minutes must be an integer, got ${String(project.cycle_budget_minutes)}`,
    );
  }

  return `set -euo pipefail

# Codex typically lands on PATH via npm/brew. Keep ~/.local/bin for
# user-local installs in non-login dispatcher subprocesses.
export PATH="$HOME/.local/bin:$PATH"

# gs-291: deterministic claim when dispatcher pre-resolved nextTask (stdout for
# parseTaskClaimFromEngineerStdout). Model may print another line later; the
# parser keeps the last matching line.
${claimEchoBlock}
BUDGET=${project.cycle_budget_minutes}
PROJECT_ROOT="$PWD"
WORKTREE_DIR="$PROJECT_ROOT/.bot-worktree"
BRANCH=${qBranch}

echo "=== codex engineer (project=${qProjectId}) ==="
${modelEcho}
echo "Budget: \${BUDGET} min"
echo "Worktree: \$WORKTREE_DIR"
echo "Started: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Codex is auth'd via the operator's subscription login from \`codex login\`.
# Surface a clear error if the binary is missing.
if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: 'codex' not found on PATH. Install: npm install -g @openai/codex (then run 'codex login')." >&2
  exit 127
fi

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

# Best-effort repo-structure orientation of the WORKTREE (the code the agent
# edits). Prints an orientation block on success, NOTHING on any failure /
# timeout (helper exits 0 regardless), so it can never break the cycle.
REPO_CTX="\$(bash "\$GENERALSTAFF_ROOT/scripts/gen-repo-context.sh" "\$WORKTREE_DIR" 2>/dev/null || true)"

# Best-effort dependency install. Provider-agnostic stack detection; never
# hard-fails — the verification gate catches any real break.
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

echo ""
echo "Launching codex..."
echo ""

# Combine the (possibly empty) runtime repo-map orientation with the static
# engineer prompt. When REPO_CTX is empty, MSG === PROMPT.
PROMPT=${qPrompt}
if [ -n "\$REPO_CTX" ]; then
  MSG="\${REPO_CTX}"$'\\n\\n'"\${PROMPT}"
else
  MSG="\${PROMPT}"
fi

# exec : non-interactive one-shot.
# --cd / -C : pin the agent to the worktree (GS manages its own worktree).
# -s workspace-write : allow file edits; Codex cannot write .git under this
#   sandbox — GS owns commit / push after verification.
# --ignore-user-config / --skip-git-repo-check : keep headless runs clean.
# Model flag only when engineer_model is set (omit = Codex CLI default).
codex exec \\
  --ignore-user-config \\
  --skip-git-repo-check \\
  --cd "\$WORKTREE_DIR" \\
  -s workspace-write${modelFlag} \\
  "\$MSG"

EXIT=\$?
echo ""
echo "codex finished. Exit: \$EXIT"
echo "Ended: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit \$EXIT`;
}
