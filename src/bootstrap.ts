// GeneralStaff — bootstrap command: scaffold a new project's
// .generalstaff-proposal/ staging directory. Propose-don't-impose
// per FUTURE-DIRECTIONS §9 and Hard Rule 1's opt-in-creative
// pathway. The user reviews the staging dir, moves files into
// place, and registers manually via projects.yaml.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join, basename } from "path";
import { $ } from "bun";

export type StackKind =
  | "bun-next"
  | "bun-plain"
  | "node-next"
  | "rust-cargo"
  | "python-poetry"
  | "go-mod"
  | "unknown";

export interface DetectedStack {
  kind: StackKind;
  verifyCommand: string;
  engineerCommand: string;
}

export interface BootstrapOptions {
  targetDir: string;
  idea: string;
  stack?: StackKind;
  force?: boolean;
  projectId?: string; // Defaults to basename(targetDir)
}

export interface BootstrapResult {
  ok: boolean;
  reason?: string;
  proposalPath?: string;
  createdScaffold?: boolean;
  detectedStack?: DetectedStack;
  projectId?: string;
}

const PROPOSAL_DIR = ".generalstaff-proposal";

// Default engineer-command invocation the user registers in
// GeneralStaff's projects.yaml. Points at the generated
// engineer_command.sh (which handles worktree management +
// prompting claude). The ${cycle_budget_minutes} placeholder is
// substituted by the dispatcher at invocation time.
const DEFAULT_ENGINEER_COMMAND = "bash engineer_command.sh ${cycle_budget_minutes}";

// Generate the body of the proposal's engineer_command.sh. Mirrors
// the pattern in gamr/engineer_command.sh (the first manually-
// patched instance during Phase 3): create .bot-worktree on
// bot/work, install deps, invoke claude -p with a full prompt
// scoped to this project's tasks.json + hands_off + verify
// command + budget. Without this, a newly-bootstrapped project's
// first bot cycle would run a promptless `claude -p` on the main
// working tree — clobbering the user's interactive work.
function engineerCommandScript(
  projectId: string,
  verifyCommand: string,
): string {
  return `#!/usr/bin/env bash
# ${projectId} — autonomous engineering bot launcher
#
# Usage: bash engineer_command.sh [budget_minutes]
#
# Invoked by GeneralStaff's dispatcher per the engineer_command field
# in GeneralStaff's projects.yaml. Creates a git worktree at
# .bot-worktree on branch bot/work, runs claude -p inside it, exits.
# Cleanup is the dispatcher's responsibility (see GeneralStaff's
# src/cycle.ts — verification runs IN the worktree, then it's removed).

set -euo pipefail

BUDGET_MINUTES="\${1:-30}"
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
PROJECT_ROOT="\$SCRIPT_DIR"
WORKTREE_DIR="\$PROJECT_ROOT/.bot-worktree"
BRANCH="bot/work"

echo "=== ${projectId} Bot Launcher ==="
echo "Budget: \${BUDGET_MINUTES} min"
echo "Project root: \$PROJECT_ROOT"
echo "Worktree: \$WORKTREE_DIR"
echo "Branch: \$BRANCH"
echo "Started: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "================================="

# --- Ensure bot/work branch exists ---
if ! git -C "\$PROJECT_ROOT" rev-parse --verify "\$BRANCH" >/dev/null 2>&1; then
  echo "Creating branch \$BRANCH from master..."
  git -C "\$PROJECT_ROOT" branch "\$BRANCH" master
fi

# --- Create worktree ---
git -C "\$PROJECT_ROOT" worktree prune 2>/dev/null || true

if [ -d "\$WORKTREE_DIR" ]; then
  echo "Stale worktree found — removing..."
  git -C "\$PROJECT_ROOT" worktree remove "\$WORKTREE_DIR" --force 2>/dev/null || true
  rm -rf "\$WORKTREE_DIR" 2>/dev/null || true
fi

echo "Creating worktree at \$WORKTREE_DIR on \$BRANCH..."
git -C "\$PROJECT_ROOT" worktree add "\$WORKTREE_DIR" "\$BRANCH"

# --- Install dependencies in worktree ---
echo "Installing dependencies in worktree..."
cd "\$WORKTREE_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install

# --- Run autonomous bot ---
echo ""
echo "Launching autonomous claude -p in worktree..."
echo ""

claude -p "You are an autonomous engineering bot working on the ${projectId} project.

## Your environment
You are in a git worktree on the bot/work branch. The main working tree
is on master and may be in use by a human. Do NOT touch the main working
tree — work only in this directory.

## Your task
Read state/${projectId}/tasks.json and pick the highest-priority unfinished task
(status: 'pending', lowest priority number first; among same-priority
tasks, lowest id first). Work on exactly that task — no scope creep.

## What you can do
- Add, modify, or delete files at the paths the task explicitly names.
- Add test files that support the claimed work.
- Run \\\`bun install\\\` if needed (lockfile must already be committed).
- Run \\\`${verifyCommand}\\\` to verify your changes.
- Commit with a message describing the task you completed.
- Update the task's status to 'done' in state/${projectId}/tasks.json after
  committing.

## What you must NOT do
- Modify any file matching a pattern in hands_off.yaml.
- Touch CLAUDE-AUTONOMOUS.md, idea.md, README.md, or hands_off.yaml.
- Invent product features, write user-facing copy, or make UX decisions.
- Pick algorithms — those are reserved for the human. If a task asks for
  something that requires an algorithmic decision, abandon the task and
  write a short note explaining why.

## Verification gate
Tests must pass under \\\`${verifyCommand}\\\` before commit.
If they don't pass, fix or abandon — never commit failing tests.

## Budget
You have \${BUDGET_MINUTES} minutes total. Stop before the budget runs out.
After committing one task, do NOT pick another in the same invocation —
the dispatcher will start a fresh cycle for the next task.
" \\
  --allowedTools "Read,Write,Edit,Bash,Grep,Glob" \\
  --output-format text

echo ""
echo "Bot finished. Exit code: \$?"
echo "Ended: \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
`;
}

function stackDefaults(kind: StackKind): DetectedStack {
  switch (kind) {
    case "bun-next":
      return {
        kind,
        verifyCommand: "bun test && bun x tsc --noEmit",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
    case "bun-plain":
      return {
        kind,
        verifyCommand: "bun test && bun x tsc --noEmit",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
    case "node-next":
      return {
        kind,
        verifyCommand: "npm test && npm run typecheck",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
    case "rust-cargo":
      return {
        kind,
        verifyCommand: "cargo test && cargo clippy -- -D warnings",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
    case "python-poetry":
      return {
        kind,
        verifyCommand: "poetry run pytest && poetry run ruff check",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
    case "go-mod":
      return {
        kind,
        verifyCommand: "go test ./... && go vet ./...",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
    case "unknown":
      return {
        kind,
        verifyCommand: "# TODO: define verification command",
        engineerCommand: DEFAULT_ENGINEER_COMMAND,
      };
  }
}

// Detect the stack by reading file markers in the target dir.
// If explicitStack is provided, it wins unconditionally.
export function detectStack(
  targetDir: string,
  explicitStack?: StackKind,
): DetectedStack {
  if (explicitStack) return stackDefaults(explicitStack);

  if (!existsSync(targetDir)) {
    return stackDefaults("unknown");
  }

  const pkgJson = join(targetDir, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const hasNext = Boolean(deps.next);
      const hasBun = Boolean(
        deps["@types/bun"] || pkg.packageManager?.startsWith("bun"),
      );
      if (hasNext && hasBun) return stackDefaults("bun-next");
      if (hasNext) return stackDefaults("node-next");
      if (hasBun) return stackDefaults("bun-plain");
      return stackDefaults("bun-plain");
    } catch {
      return stackDefaults("unknown");
    }
  }

  if (existsSync(join(targetDir, "Cargo.toml"))) return stackDefaults("rust-cargo");
  if (existsSync(join(targetDir, "pyproject.toml"))) return stackDefaults("python-poetry");
  if (existsSync(join(targetDir, "go.mod"))) return stackDefaults("go-mod");

  return stackDefaults("unknown");
}

// Scaffold a minimum-viable repo for greenfield stacks. Writes
// package.json, tsconfig.json, .gitignore, README.md. Does NOT
// write any source code — the bot's bounded tasks will scaffold
// src/ and tests/.
export function scaffoldMinimalRepo(
  targetDir: string,
  stack: StackKind,
  idea: string,
  projectId: string,
): void {
  mkdirSync(targetDir, { recursive: true });

  if (stack === "bun-next") {
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify(
        {
          name: projectId,
          version: "0.0.1",
          private: true,
          type: "module",
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            test: "bun test",
            typecheck: "bun x tsc --noEmit",
          },
          dependencies: {
            next: "^15.0.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@types/bun": "latest",
            "@types/node": "^22.0.0",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            typescript: "^5.9.0",
            tailwindcss: "^4.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(targetDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "preserve",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            noEmit: true,
            allowJs: true,
            incremental: true,
            paths: { "@/*": ["./src/*"] },
          },
          include: ["**/*.ts", "**/*.tsx"],
          exclude: ["node_modules", ".next", "dist"],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(targetDir, ".gitignore"),
      "node_modules/\n.next/\ndist/\nbuild/\n.env\n.env.local\n*.log\n",
    );
  } else if (stack === "bun-plain") {
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify(
        {
          name: projectId,
          version: "0.0.1",
          private: true,
          type: "module",
          scripts: {
            test: "bun test",
            typecheck: "bun x tsc --noEmit",
          },
          devDependencies: {
            "@types/bun": "latest",
            typescript: "^5.9.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(targetDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(targetDir, ".gitignore"),
      "node_modules/\ndist/\n.env\n*.log\n",
    );
  }
  // Other stacks (rust/python/go): skip scaffolding for the
  // minimum-viable pass. User runs `cargo init` / `poetry init`
  // / `go mod init` before bootstrapping. Documented in the
  // proposal README.

  writeFileSync(
    join(targetDir, "README.md"),
    `# ${projectId}\n\n${idea}\n\n## Status\n\nGenerated by \`generalstaff bootstrap\` ${new Date().toISOString().slice(0, 10)}. Vision + scope live in \`CLAUDE-AUTONOMOUS.md\` once you move it out of \`.generalstaff-proposal/\`.\n`,
  );
}

// Emit tasks.json content. Stack-specific bounded scaffolding
// tasks. ALL correctness work — no feature invention.
function tasksJsonForStack(stack: StackKind, projectId: string): string {
  const prefix = projectId.slice(0, 4).toLowerCase().replace(/[^a-z]/g, "");
  const id = (n: number) => `${prefix}-${String(n).padStart(3, "0")}`;

  if (stack === "bun-next") {
    const tasks = [
      { title: "Scaffold src/ directory with empty app/ Next.js 15 app-router layout (app/layout.tsx + app/page.tsx). Minimal boilerplate only — no copy, no styling decisions. Link to README's title in <h1>.", priority: 1 },
      { title: "Add tailwind.config.ts and postcss.config.mjs with Tailwind v4 defaults. Wire app/globals.css with @import 'tailwindcss'. Do not decide color palette or typography.", priority: 1 },
      { title: "Scaffold tests/ directory with a placeholder test at tests/smoke.test.ts that imports app/page.tsx and asserts the component renders without throwing. Run bun test to confirm it passes.", priority: 1 },
      { title: "Add a src/types/ directory with a User type in src/types/user.ts — fields: id (string), displayName (string), createdAt (ISO string). Add tests/types/user.test.ts asserting the type compiles and a sample User object satisfies it.", priority: 2 },
      { title: "Add src/types/match.ts with a Match type — fields: id (string), userIdA (string), userIdB (string), status ('pending'|'accepted'|'declined'), createdAt (ISO string). Add test asserting type compiles.", priority: 2 },
      { title: "Add src/lib/db.ts as a stub data layer. Export an in-memory Map<string, User> and Map<string, Match>. Export read/write helpers: getUser, listUsers, createUser, getMatch, listMatches, createMatch. Add tests covering each helper. Do NOT pick a real database — stays in-memory until decided.", priority: 1 },
      { title: "Scaffold app/api/users/route.ts with GET (list) and POST (create) handlers using src/lib/db.ts. Add tests exercising both routes with a test fixture User payload. No auth, no validation beyond required-fields.", priority: 2 },
      { title: "Scaffold app/api/matches/route.ts with GET (list) and POST (create) handlers wired to src/lib/db.ts. Add tests.", priority: 2 },
      { title: "Add src/lib/validation.ts with tiny Zod-free pure functions: isNonEmptyString, isIsoDate, assertRequiredFields. Use them in the /api/users and /api/matches POST handlers. Add tests for each.", priority: 2 },
      { title: "Add app/page.tsx server-side fetch of /api/users list. Render a plain <ul> of displayName values. No styling beyond Tailwind default container. No UX decisions.", priority: 3 },
      { title: "Add a src/lib/ directory README (src/lib/README.md) documenting each exported helper, one line per function. Helps future contributors navigate the scaffold.", priority: 3 },
      { title: "Add a CI-style npm-run-all invocation via a scripts/check.sh that runs: bun install --frozen-lockfile, bun test, bun x tsc --noEmit. Not auto-invoked; document usage in README. Tests: verify the script exists and is executable.", priority: 3 },
    ];
    return JSON.stringify(
      tasks.map((t, i) => ({
        id: id(i + 1),
        title: t.title,
        status: "pending",
        priority: t.priority,
      })),
      null,
      2,
    ) + "\n";
  }

  if (stack === "bun-plain") {
    const tasks = [
      { title: "Scaffold src/ directory with src/index.ts exporting a hello() function returning a fixed string. Add tests/index.test.ts asserting hello() returns that string.", priority: 1 },
      { title: "Add src/types.ts with project-wide type definitions (start with a placeholder Identity type). Tests/types.test.ts asserting types compile.", priority: 2 },
      { title: "Add src/lib/ subdirectory with a README explaining its purpose (utility modules only, no features). Leave empty otherwise.", priority: 3 },
    ];
    return JSON.stringify(
      tasks.map((t, i) => ({
        id: id(i + 1),
        title: t.title,
        status: "pending",
        priority: t.priority,
      })),
      null,
      2,
    ) + "\n";
  }

  // Generic fallback — 3 bounded tasks that work for any stack.
  const tasks = [
    { title: "Add a README.md section describing the bot's current scope (correctness work only; creative decisions stay with the user). Reference the hands_off.yaml list.", priority: 1 },
    { title: "Add a tests/ directory with a single smoke test asserting the project builds successfully via the verify_command.", priority: 1 },
    { title: "Add a CONTRIBUTING.md stub noting: correctness PRs welcome; feature PRs flagged for human review per Rule 1.", priority: 3 },
  ];
  return JSON.stringify(
    tasks.map((t, i) => ({
      id: id(i + 1),
      title: t.title,
      status: "pending",
      priority: t.priority,
    })),
    null,
    2,
  ) + "\n";
}

function handsOffYamlForStack(stack: StackKind): string {
  const common = [
    { pattern: "node_modules/", why: "Generated dependency tree; never edited by hand." },
    { pattern: ".next/", why: "Next.js build artifacts." },
    { pattern: "dist/", why: "Build output." },
    { pattern: "build/", why: "Build output." },
    { pattern: ".env", why: "Secrets; never committed, never bot-edited." },
    { pattern: ".env.local", why: "Local secrets." },
    { pattern: "CLAUDE-AUTONOMOUS.md", why: "Project vision is the user's call, not the bot's." },
    { pattern: "idea.md", why: "Raw idea statement; kept as source-of-truth for scope." },
    { pattern: "hands_off.yaml", why: "Bot cannot edit its own scope rules." },
    { pattern: "README.md", why: "User-facing copy is taste work; stays with the user." },
    { pattern: ".generalstaff-proposal/", why: "Staging directory from bootstrap; never bot-edited." },
  ];

  const stackSpecific: Array<{ pattern: string; why: string }> = [];
  if (stack === "bun-next" || stack === "node-next") {
    stackSpecific.push(
      { pattern: "src/lib/matchmaking.ts", why: "(if this file is ever created) matching/business algorithms are taste work." },
      { pattern: "app/**/page-content.tsx", why: "(if ever created) user-facing copy is taste work." },
    );
  }

  const all = [...common, ...stackSpecific];
  const lines = [
    "# Hands-off patterns — autonomous bot will refuse to modify these.",
    "# Format: each entry is a glob-like pattern (basename or path).",
    "# Rule 5 requires this list be non-empty before registration.",
    "",
    "patterns:",
  ];
  for (const { pattern, why } of all) {
    lines.push(`  - "${pattern}"  # ${why}`);
  }
  lines.push("");
  lines.push("# Add any file containing business logic, algorithms, or");
  lines.push("# creative UX decisions as you write them. Start restrictive;");
  lines.push("# loosen only after observing the bot respects the existing list.");
  return lines.join("\n") + "\n";
}

function claudeAutonomousMd(projectId: string, idea: string, stack: DetectedStack): string {
  return `# ${projectId} — Autobot Contract

> Generated by \`generalstaff bootstrap\` ${new Date().toISOString().slice(0, 10)}.
> Edit the \`<FILL IN>\` sections before moving this file out of \`.generalstaff-proposal/\`.

## Idea (raw, as provided)

${idea}

## Vision

<FILL IN: one-paragraph user-facing vision. Keep this short; bots don't need epic
descriptions, they need scope. What does success look like in one sentence?>

## Scope for the autonomous bot

**The bot SHOULD do:**
- Correctness work on bounded tasks listed in \`tasks.json\`.
- Scaffolding of structures the user has specified (types, routes, tests, utilities).
- Test coverage for existing code.
- Small refactors with clear inputs and outputs.

**The bot SHOULD NOT do:**
- Design the product.
- Invent features.
- Write user-facing copy.
- Decide algorithms (matching, pricing, ranking, etc.).
- Pick UX patterns, color palettes, typography, or visual design.
- Modify files in \`hands_off.yaml\`.

These are Ray's decisions. The bot proposes; Ray disposes.

## Tech stack

- **Detected / specified:** \`${stack.kind}\`
- **Verify command:** \`${stack.verifyCommand}\`
- **Engineer command:** \`${stack.engineerCommand}\`

## Hands-off surface

See \`hands_off.yaml\` — both the full list and the "why" for each pattern.

## How to add work

Append to \`tasks.json\`. Each task object:

\`\`\`json
{ "id": "<prefix>-NNN", "title": "<specific action>", "status": "pending", "priority": 1 }
\`\`\`

Keep titles specific: file paths, function names, assertions. Vague titles
produce scope drift; specific titles produce clean commits.

## Evaluation criteria

<FILL IN: how will you know the bot is doing its job well? e.g., "cycles
verified-rate >= 80%, scope-drift rate <= 5%, no hands-off violations."
These become the target metrics once the project is registered.>
`;
}

function readmeProposal(projectId: string, stack: DetectedStack, createdScaffold: boolean): string {
  return `# Proposal for ${projectId} (generalstaff bootstrap output)

This directory (\`.generalstaff-proposal/\`) is a **staging area**. Nothing
here is live yet. Review each file, edit as needed, then move them into
place and register the project.

## Files in this proposal

| File | What it is | Your action |
| --- | --- | --- |
| \`CLAUDE-AUTONOMOUS.md\` | Autobot contract draft | Edit the \`<FILL IN>\` sections. Move to repo root. |
| \`hands_off.yaml\` | Restrictive hands-off patterns | Review each entry. Keep restrictive; loosen later. |
| \`verify_command.sh\` | Verification gate command | Confirm matches your test/build setup. |
| \`engineer_command.sh\` | Bot engineer launcher | Confirm or replace with your per-project wrapper. |
| \`idea.md\` | Raw idea statement | Kept for reference; source-of-truth for future scope decisions. |
| \`README-PROPOSAL.md\` | This file | Read, then delete. |

${createdScaffold ? `## Minimum scaffold written

A baseline \`package.json\`, \`tsconfig.json\`, \`.gitignore\`, and \`README.md\`
were also written to the project root — those are live (not in the proposal
dir). Review them; they are deliberately minimal. The bot's seeded tasks
will scaffold \`src/\` and \`tests/\` from there.

` : ""}## Seeded backlog — already live

\`tasks.json\` was written to \`state/${projectId}/tasks.json\` in this
project's root (NOT in the proposal dir). That is the canonical location
the dispatcher reads; keeping it there means the file travels with your
project's git history. Review it and edit titles/priorities in place.

## Next steps

1. **Review \`CLAUDE-AUTONOMOUS.md\`.** Fill in the Vision + Evaluation
   criteria sections. These shape everything else.
2. **Review \`hands_off.yaml\`.** Rule 5 requires this list be non-empty.
   The generated list is restrictive on purpose — add more as you write
   code with business logic.
3. **Review \`state/${projectId}/tasks.json\`** (in this project's root).
   Remove any task whose scope you disagree with. The bot will pick
   highest priority first; edit priorities accordingly.
4. **Move files into place:**
   - \`CLAUDE-AUTONOMOUS.md\` → project root
   - \`hands_off.yaml\` → project root
   - \`idea.md\` → project root (optional — reference only)
5. **Register in projects.yaml** (inside the GeneralStaff repo) with:

   \`\`\`yaml
   - id: ${projectId}
     path: <absolute path to this project>
     priority: 2
     engineer_command: "${stack.engineerCommand}"
     verification_command: "${stack.verifyCommand}"
     cycle_budget_minutes: 30
     work_detection: tasks_json
     concurrency_detection: worktree
     branch: bot/work
     auto_merge: false      # MUST be false until 5 clean cycles (Hard Rule 4)
     hands_off:
       # Copy patterns from hands_off.yaml here
   \`\`\`

6. **Run a dry cycle** with \`generalstaff cycle --project=${projectId} --dry-run\`
   to confirm detection + scope before real cycles fire.
7. **Launch a session** with \`generalstaff session --budget=30\` — start
   short. Review results, raise budget after 2-3 clean sessions.

## Reminder: Rule 1 still applies

The bot does correctness work. You provide the creative direction
(vision, algorithms, copy, UX). The bot proposes scaffolding and tests;
you decide what the product actually does.
`;
}

function generateProposal(
  targetDir: string,
  stack: DetectedStack,
  idea: string,
  projectId: string,
  createdScaffold: boolean,
): void {
  const proposalDir = join(targetDir, PROPOSAL_DIR);
  mkdirSync(proposalDir, { recursive: true });

  writeFileSync(
    join(proposalDir, "CLAUDE-AUTONOMOUS.md"),
    claudeAutonomousMd(projectId, idea, stack),
  );
  writeFileSync(
    join(proposalDir, "hands_off.yaml"),
    handsOffYamlForStack(stack.kind),
  );
  writeFileSync(
    join(proposalDir, "verify_command.sh"),
    `#!/usr/bin/env bash\nset -euo pipefail\n${stack.verifyCommand}\n`,
  );
  writeFileSync(
    join(proposalDir, "engineer_command.sh"),
    engineerCommandScript(projectId, stack.verifyCommand),
  );
  writeFileSync(join(proposalDir, "idea.md"), `# Raw idea\n\n${idea}\n`);
  writeFileSync(
    join(proposalDir, "README-PROPOSAL.md"),
    readmeProposal(projectId, stack, createdScaffold),
  );

  // tasks.json goes to the canonical per-project state location
  // (${targetDir}/state/<projectId>/tasks.json) rather than the
  // proposal staging dir. gs-166 aligned runtime reads to this
  // path; gs-167 aligns bootstrap writes so the file is already
  // where the dispatcher looks for it. Do not overwrite an
  // existing tasks.json — the user may have edited it.
  const stateDir = join(targetDir, "state", projectId);
  mkdirSync(stateDir, { recursive: true });
  const tasksPath = join(stateDir, "tasks.json");
  if (!existsSync(tasksPath)) {
    writeFileSync(tasksPath, tasksJsonForStack(stack.kind, projectId));
  }
}

// Main entry point. Called by the CLI. Idempotent if --force
// is set; otherwise refuses to overwrite an existing proposal.
export async function runBootstrap(
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const projectId = opts.projectId ?? basename(opts.targetDir);

  // Validate idea + project id
  if (!opts.idea || !opts.idea.trim()) {
    return { ok: false, reason: "Idea is required and cannot be empty." };
  }
  if (!projectId || !/^[a-z0-9_-]+$/i.test(projectId)) {
    return {
      ok: false,
      reason: `Project id "${projectId}" invalid. Use alphanumerics, dashes, and underscores only.`,
    };
  }

  const proposalPath = join(opts.targetDir, PROPOSAL_DIR);
  const dirExists = existsSync(opts.targetDir);
  const dirEmpty = dirExists ? readdirSync(opts.targetDir).length === 0 : true;

  // Refuse to overwrite existing proposal unless --force
  if (dirExists && existsSync(proposalPath) && !opts.force) {
    return {
      ok: false,
      reason: `Proposal already exists at ${proposalPath}. Re-run with --force to overwrite.`,
    };
  }

  // Determine whether we need to scaffold minimum-viable files
  const needsScaffold = !dirExists || dirEmpty;
  let createdScaffold = false;

  if (needsScaffold) {
    if (!opts.stack || opts.stack === "unknown") {
      return {
        ok: false,
        reason: `Target dir ${opts.targetDir} is empty or nonexistent. Specify --stack=<bun-next|bun-plain|rust-cargo|python-poetry|go-mod> so bootstrap knows what to scaffold.`,
      };
    }
    scaffoldMinimalRepo(opts.targetDir, opts.stack, opts.idea, projectId);
    createdScaffold = true;

    // Initialize git if not already a repo
    try {
      await $`git -C ${opts.targetDir} rev-parse --git-dir`.quiet();
    } catch {
      try {
        await $`git -C ${opts.targetDir} init`.quiet();
      } catch (e) {
        // Non-fatal; user can init manually
        console.error(`Warning: failed to git init ${opts.targetDir}: ${e}`);
      }
    }
  }

  const stack = detectStack(opts.targetDir, opts.stack);

  generateProposal(opts.targetDir, stack, opts.idea, projectId, createdScaffold);

  return {
    ok: true,
    proposalPath,
    createdScaffold,
    detectedStack: stack,
    projectId,
  };
}
