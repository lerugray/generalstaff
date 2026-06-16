// GeneralStaff — grok engineer provider (gs-331, Phase 7, v0.7.1)
//
// Generates the full bash command that runs one engineer cycle using xAI's
// Grok CLI ("Grok Build TUI") as an alternative to `claude -p` / aider. The
// generated command mirrors buildAiderCommand's shape: set up the bot/work
// worktree, install deps best-effort, run the provider CLI headlessly with a
// task prompt, exit with its code. The dispatcher (cycle.ts) captures the git
// diff, runs verification, and runs the reviewer afterwards — provider-
// agnostic, same as the claude / aider paths.
//
// Auth model differs from aider: the Grok CLI is backed by the operator's
// grok.com SUBSCRIPTION via `grok login` (~/.grok/auth.json), NOT an API key.
// (A GROK_DEPLOYMENT_KEY env var is an alternative for enterprise/headless
// deploys.) So unlike aider's OPENROUTER_API_KEY, there's no per-token key to
// pass — Hard Rule 8 BYOK is satisfied by the operator's own logged-in CLI.
// This is the cheap-capacity win: cycles run on the flat-rate sub, off the
// Anthropic cap and off per-token OpenRouter spend.

import type { ProjectConfig, CycleCreativeContext, GreenfieldTask } from "../types";
import { buildAiderPrompt } from "./aider";
import { GENERALSTAFF_TASK_CLAIM_PREFIX } from "../prompts/engineer_claim";

// The Grok CLI's default coder model. `grok-build` is the reasoning variant
// (and the only one that accepts --reasoning-effort). Override per-project via
// `engineer_model` or per-task via `task.engineer_model`.
export const DEFAULT_GROK_MODEL = "grok-composer-2.5-fast";

// Shell-quote a string for use inside bash single quotes (the only escape
// with no surprises). Mirrors aider.ts's private helper; duplicated here to
// keep the provider modules independent.
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Build the bash command that runs one Grok engineer cycle. Reuses the
// provider-agnostic engineer prompt (buildAiderPrompt — it never mentions
// aider; it's the generic "autonomous engineering bot" brief with the task,
// hands_off list, verification gate, and GeneralStaff-CLI task-done
// instructions). Worktree setup, claim echo, dep install, and repo-context
// orientation are identical in shape to the aider path.
export function buildGrokCommand(
  project: ProjectConfig,
  context?: CycleCreativeContext,
  nextTask?: GreenfieldTask,
): string {
  const model = project.engineer_model ?? DEFAULT_GROK_MODEL;
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

  const qModel = shellSingleQuote(model);
  const qBranch = shellSingleQuote(effectiveBranch);
  const qPrompt = shellSingleQuote(prompt);
  const qProjectId = shellSingleQuote(project.id);

  // cycle_budget_minutes crosses the YAML parse boundary; assert integer at
  // the interpolation site (it lands unquoted as `BUDGET=N` in the bash).
  if (!Number.isInteger(project.cycle_budget_minutes)) {
    throw new Error(
      `project ${project.id}: cycle_budget_minutes must be an integer, got ${String(project.cycle_budget_minutes)}`,
    );
  }

  return `set -euo pipefail

# The Grok CLI installs to ~/.grok/bin (and symlinks ~/.local/bin), adding the
# former to PATH via the shell profile. A non-login dispatcher subprocess may
# not have sourced that profile, so put both on PATH explicitly.
export PATH="$HOME/.grok/bin:$HOME/.local/bin:$PATH"

# gs-291: deterministic claim when dispatcher pre-resolved nextTask (stdout for
# parseTaskClaimFromEngineerStdout). Model may print another line later; the
# parser keeps the last matching line.
${claimEchoBlock}
BUDGET=${project.cycle_budget_minutes}
PROJECT_ROOT="$PWD"
WORKTREE_DIR="$PROJECT_ROOT/.bot-worktree"
BRANCH=${qBranch}

echo "=== grok engineer (project=${qProjectId}) ==="
echo "Model: ${qModel}"
echo "Budget: \${BUDGET} min"
echo "Worktree: \$WORKTREE_DIR"
echo "Started: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Grok is auth'd via the operator's subscription login (~/.grok/auth.json)
# from \`grok login\`, or a GROK_DEPLOYMENT_KEY env var. Surface a clear error
# upstream if neither is present — grok will fail anyway, but loudly here
# saves log-reading time.
if [ ! -f "\$HOME/.grok/auth.json" ] && [ -z "\${GROK_DEPLOYMENT_KEY:-}" ]; then
  echo "WARNING: not logged in to Grok (no ~/.grok/auth.json and no GROK_DEPLOYMENT_KEY) — run 'grok login'." >&2
fi
if ! command -v grok >/dev/null 2>&1; then
  echo "ERROR: 'grok' not found on PATH. Install: curl -fsSL https://x.ai/cli/install.sh | bash" >&2
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
echo "Launching grok..."
echo ""

# Combine the (possibly empty) runtime repo-map orientation with the static
# engineer prompt. When REPO_CTX is empty, MSG === PROMPT.
PROMPT=${qPrompt}
if [ -n "\$REPO_CTX" ]; then
  MSG="\${REPO_CTX}"$'\\n\\n'"\${PROMPT}"
else
  MSG="\${PROMPT}"
fi

# -p / --single : headless single-prompt mode (run the agent to completion).
# --always-approve : auto-approve all tool executions so the agent can edit
#   files and commit autonomously (the prompt instructs it to commit + mark
#   the task done via the GeneralStaff CLI).
# -m : model id. --cwd pins the agent to the worktree. GS manages its own
#   worktree, so we deliberately do NOT pass grok's own -w/--worktree.
grok \\
  --single "\$MSG" \\
  --model ${qModel} \\
  --always-approve \\
  --cwd "\$WORKTREE_DIR"

EXIT=\$?
echo ""
echo "grok finished. Exit: \$EXIT"
echo "Ended: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit \$EXIT`;
}
