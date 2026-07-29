// GeneralStaff — kimi engineer provider (2026-07-29, experimental)
//
// Generates the full bash command that runs one engineer cycle using
// Moonshot's kimi-code CLI as an alternative to `claude -p` / aider / grok.
// The generated command mirrors buildGrokCommand's shape: set up the bot/work
// worktree, install deps best-effort, run the provider CLI headlessly with a
// task prompt, exit with its code. The dispatcher (cycle.ts) captures the git
// diff, runs verification, and runs the reviewer afterwards — provider-
// agnostic.
//
// Auth model matches grok: the kimi CLI is backed by the operator's own
// Kimi Code subscription via `kimi login`, NOT an API key shipped by
// GeneralStaff. Hard Rule 8 BYOK is satisfied by the operator's own logged-
// in CLI. `-p` mode auto-approves tools (writes files, runs shell) — do NOT
// also pass --yolo/--auto (kimi rejects that combination).

import type { ProjectConfig, CycleCreativeContext, GreenfieldTask } from "../types";
import { buildAiderPrompt } from "./aider";
import { GENERALSTAFF_TASK_CLAIM_PREFIX } from "../prompts/engineer_claim";

// Shell-quote a string for use inside bash single quotes (the only escape
// with no surprises). Mirrors grok.ts / aider.ts; duplicated to keep
// provider modules independent.
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Build the bash command that runs one kimi engineer cycle. Reuses the
// provider-agnostic engineer prompt (buildAiderPrompt). Worktree setup,
// claim echo, dep install, and repo-context orientation match the grok path.
//
// Model policy: omit `-m` when engineer_model is unset so kimi's
// config.toml default_model applies. When set, pass `-m <model>`.
export function buildKimiCommand(
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
      : `echo "Model: (kimi config.toml default)"`;

  if (!Number.isInteger(project.cycle_budget_minutes)) {
    throw new Error(
      `project ${project.id}: cycle_budget_minutes must be an integer, got ${String(project.cycle_budget_minutes)}`,
    );
  }

  return `set -euo pipefail

# kimi-code installs to ~/.kimi-code/bin. A non-login dispatcher subprocess
# may not have sourced the profile that adds it, so put it on PATH explicitly.
export PATH="$HOME/.kimi-code/bin:$HOME/.local/bin:$PATH"

# gs-291: deterministic claim when dispatcher pre-resolved nextTask (stdout for
# parseTaskClaimFromEngineerStdout). Model may print another line later; the
# parser keeps the last matching line.
${claimEchoBlock}
BUDGET=${project.cycle_budget_minutes}
PROJECT_ROOT="$PWD"
WORKTREE_DIR="$PROJECT_ROOT/.bot-worktree"
BRANCH=${qBranch}

echo "=== kimi engineer (project=${qProjectId}) ==="
${modelEcho}
echo "Budget: \${BUDGET} min"
echo "Worktree: \$WORKTREE_DIR"
echo "Started: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# kimi is auth'd via the operator's subscription login from \`kimi login\`.
# Surface a clear error if the binary is missing.
if ! command -v kimi >/dev/null 2>&1; then
  echo "ERROR: 'kimi' not found on PATH. Install: curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash (then run 'kimi login')." >&2
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
echo "Launching kimi..."
echo ""

# Combine the (possibly empty) runtime repo-map orientation with the static
# engineer prompt. When REPO_CTX is empty, MSG === PROMPT.
PROMPT=${qPrompt}
if [ -n "\$REPO_CTX" ]; then
  MSG="\${REPO_CTX}"$'\\n\\n'"\${PROMPT}"
else
  MSG="\${PROMPT}"
fi

# Headless single-prompt mode (auto-approves tools). Do not combine with
# interactive auto-approve flags — kimi rejects that combination.
# No -C flag: we already cd'd into the worktree above, so cwd is the pin.
# Model flag only when engineer_model is set (omit = config.toml default).
kimi \\
  -p "\$MSG"${modelFlag}

EXIT=\$?
echo ""
echo "kimi finished. Exit: \$EXIT"
echo "Ended: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit \$EXIT`;
}
