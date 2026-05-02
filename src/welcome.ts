// GeneralStaff — interactive first-run wizard (`gs welcome`).
//
// Composes existing primitives (provider config, runBootstrap,
// runRegister, runSession) into one guided flow for non-technical
// users. The wizard's purpose is to take someone from "just cloned
// the repo" to "ran one verified cycle and understands what they
// just saw" in roughly 30 minutes of wall clock time.
//
// Voice: light staff-officer framing — "Commander", "brief your
// first staff officer", "receive your first dispatch". The military
// vocabulary is flavor only; the substance of every prompt is
// plain. A non-technical user should not have to decode the theme.
//
// Architecture: a step state machine. Each step is its own async
// function returning a discriminated result; the orchestrator runs
// them in order, with abort handling between each. All I/O is
// injected via PromptFn / WriteFn so tests can drive the wizard
// without real stdin/stdout.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { spawnSync } from "child_process";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { getRootDir } from "./state";
import { runBootstrap, type BootstrapResult } from "./bootstrap";
import { runRegister, type RegisterResult } from "./register";
import { loadProviderRegistry } from "./providers/registry";

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export type PromptFn = (
  question: string,
  defaultAnswer?: string,
) => Promise<string>;

export type WriteFn = (text: string) => void;

export interface WelcomeOptions {
  promptFn?: PromptFn;
  writeFn?: WriteFn;
  // Skip the actual cycle invocation. Used by tests + by a
  // "preview" mode where the user wants to see the wizard's flow
  // without burning provider credits on a real cycle.
  skipCycle?: boolean;
  // Override the GS root dir. Used by tests to operate on a
  // temp dir.
  rootDirOverride?: string;
}

export interface WelcomeResult {
  ok: boolean;
  reason?: string;
  // Names of completed steps in order — useful for tests + for
  // the "what's next" pointer.
  completedSteps: string[];
  // Captured intermediate state — used by tests, also shown in
  // the final what's-next summary.
  providerKind?: string;
  providerEnvVar?: string;
  projectId?: string;
  projectPath?: string;
  cycleRan?: boolean;
}

// ---------------------------------------------------------------
// Voice / theme helpers
// ---------------------------------------------------------------

const BANNER = `
========================================================
  GeneralStaff — Commander's Briefing
========================================================
`;

const GREETING = `
Welcome, Commander.

You're at the head of the General Staff. Your job is to
direct, not to type. The Staff handles the detail of
running Claude Code agents on your projects, and a
verification gate catches mistakes before they ship.

This briefing covers three steps:
  1. Connecting to a model provider
  2. Briefing your first staff officer (registering a project)
  3. Receiving your first dispatch (a verified cycle + audit log)

Estimated time: about 30 minutes. You can quit at any prompt
with Ctrl-C; nothing irreversible happens until each step's
final confirmation.
`;

const PROVIDER_INTRO = `
=== Step 1 of 3 — Provider Setup ===

The Staff needs a model to think with. GeneralStaff supports
three kinds today:

  ollama       Local models (free, no API key, but slower
               and lower-quality than the cloud options).
  openrouter   Cloud models including a free tier
               (Qwen / Gemma) and cheap paid tiers.
               You'll need an API key from openrouter.ai.
  claude       Anthropic's Claude. If you have a Claude Code
               subscription (Pro / Max) and \`claude\` is on
               your PATH, no API key is needed — the cycle
               uses your existing CLI session. API-key auth
               is also supported.

For your first cycle, openrouter's free tier is the easiest
path: it costs nothing, and the free Qwen and Gemma models
handle small starter tasks fine. If you already pay for
Claude Code, the claude provider is the fastest path to a
high-quality first cycle without any extra setup.
`;

const PROJECT_INTRO = `
=== Step 2 of 3 — Brief Your First Staff Officer ===

Now you point GeneralStaff at a project folder you want it
to operate on. This should be an existing folder on your
disk that has code or content you want to work on. It
doesn't need to be a git repo, but if it isn't, you'll need
to confirm that explicitly (without git history, you can't
review what the Staff changed before deciding to keep it).

The wizard will:
  - Look at your folder and detect what kind of project it is
  - Generate the GeneralStaff config files (\`.generalstaff-proposal/\`,
    \`hands_off.yaml\`, \`state/<id>/tasks.json\`)
  - Move \`hands_off.yaml\` into your project root
  - Add an entry to GeneralStaff's projects.yaml
  - Pre-load one safe starter task you can use to see the loop
`;

const DISPATCH_INTRO = `
=== Step 3 of 3 — Receive Your First Dispatch ===

Now we run one cycle. The Staff will:
  - Open a fresh git worktree on a \`bot/work\` branch
  - Run Claude Code on the starter task
  - Run your project's verification command
  - Compare the diff to the task's stated scope
  - Decide: VERIFIED, REJECTED, or WEAK

The verdict and the full diff land in the audit log
(\`state/<id>/PROGRESS.jsonl\`) — that's what you'll read
together at the end.

This first cycle uses a no-op verification command
(\`true\`, which always passes) so you can see the loop
work without needing real tests in your project. For
real work, GeneralStaff uses your project's actual test
or build command.
`;

// ---------------------------------------------------------------
// I/O defaults
// ---------------------------------------------------------------

// Build a defaultPrompt bound to a single shared readline interface.
// The wizard asks 7-9 prompts sequentially; opening + closing a fresh
// readline per prompt works for interactive stdin but hangs the second
// prompt onward when stdin is piped (e.g. from an answers file). One
// readline for the whole wizard session keeps both modes working.
function makeDefaultPrompt(): {
  promptFn: PromptFn;
  close: () => void;
} {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const promptFn: PromptFn = (question, defaultAnswer) => {
    const suffix = defaultAnswer !== undefined ? ` [${defaultAnswer}]` : "";
    return new Promise((resolveP) => {
      rl.question(`${question}${suffix} `, (answer) => {
        const trimmed = answer.trim();
        resolveP(
          trimmed.length === 0 && defaultAnswer !== undefined
            ? defaultAnswer
            : trimmed,
        );
      });
    });
  };
  return { promptFn, close: () => rl.close() };
}

function defaultWrite(text: string): void {
  process.stdout.write(text + "\n");
}

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

function isNo(answer: string): boolean {
  return /^n(o)?$/i.test(answer.trim());
}

// ---------------------------------------------------------------
// Model picker — list-of-choices replacement for the previous
// free-form `prompt("Which model?", default)`. Non-technical users
// have no way to know that "Opus 4.7" is canonically
// `claude-opus-4-7` (no space, hyphenated); typing the human-
// readable name silently writes a broken model id that only
// surfaces at cycle time. Lists let users pick by number with a
// recommended default highlighted. The "Custom" option is the
// escape hatch for power users who already know the ID they want.

interface ModelChoice {
  id: string;
  description: string;
  recommended?: boolean;
}

const CLAUDE_MODELS: ModelChoice[] = [
  {
    id: "claude-opus-4-7",
    description:
      "Highest capability. Recommended default — best signal-per-cycle, especially on flat-rate Max plans where you're not metering tokens.",
    recommended: true,
  },
  {
    id: "claude-sonnet-4-6",
    description:
      "Fast + capable. Right call when you want shorter cycle times or are running many cycles.",
  },
  {
    id: "claude-haiku-4-5",
    description:
      "Cheapest + fastest. Best for narrow / mechanical tasks where Opus is overkill.",
  },
];

const OPENROUTER_MODELS: ModelChoice[] = [
  {
    id: "qwen/qwen3-next-80b-a3b-instruct:free",
    description: "Free. Code-leaning, strong for structured / JSON tasks.",
    recommended: true,
  },
  {
    id: "google/gemma-4-31b-it:free",
    description: "Free. Prose-leaning. Good fallback when Qwen is busy.",
  },
  {
    id: "qwen/qwen3-coder-30b-a3b-instruct",
    description:
      "Paid (~$0.07/M in). Cheap + reliable when free tier is rate-limited.",
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    description: "Paid (~$3/M in). Top quality on OpenRouter.",
  },
];

const OLLAMA_MODELS: ModelChoice[] = [
  {
    id: "llama3.1",
    description: "8B params, general purpose. Common default.",
    recommended: true,
  },
  {
    id: "qwen2.5-coder:7b",
    description: "Code-leaning. Better than llama for code tasks.",
  },
];

async function pickModel(
  prompt: PromptFn,
  write: WriteFn,
  choices: ModelChoice[],
): Promise<string> {
  write("\nAvailable models (★ = recommended):");
  choices.forEach((c, i) => {
    const marker = c.recommended ? " ★" : "  ";
    write(`  ${i + 1}.${marker} ${c.id}`);
    write(`        ${c.description}`);
  });
  write(
    `  ${choices.length + 1}.    Custom — type a model ID I haven't listed.`,
  );

  const recIdx = choices.findIndex((c) => c.recommended);
  const fallbackIdx = recIdx >= 0 ? recIdx : 0;
  const defaultStr = String(fallbackIdx + 1);

  const answer = await prompt(
    "Pick a number (or type a custom model ID directly)",
    defaultStr,
  );
  const trimmed = answer.trim();
  const n = parseInt(trimmed, 10);
  // Treat as numeric only when the trimmed input is *exactly* a
  // number — "1abc" parses as 1 but is not a valid choice.
  if (!Number.isNaN(n) && String(n) === trimmed) {
    if (n >= 1 && n <= choices.length) {
      return choices[n - 1]!.id;
    }
    if (n === choices.length + 1) {
      const custom = await prompt("Type the model ID");
      return custom.trim();
    }
    write(
      `\nNumber out of range. Using recommended: ${choices[fallbackIdx]!.id}`,
    );
    return choices[fallbackIdx]!.id;
  }
  // Non-numeric: treat as a direct model ID (escape hatch for users
  // who pasted in a known-good ID).
  return trimmed;
}

// Detect whether the `claude` CLI is on PATH. Used by stepProvider to
// offer subscription-based auth (no API key) when Claude Code is
// already installed. `claude --version` is fast (sub-second) and side-
// effect-free; status === 0 means the binary ran successfully.
//
// Note: a successful version check does NOT prove the user is logged
// in — only that the binary exists. A subsequent cycle that finds the
// session unauthed will fail with the runtime's existing reviewer-
// error path. The wizard intentionally does not block on auth check
// here (would require running an actual prompt, slow + flaky).
function claudeCliAvailable(): boolean {
  try {
    const result = spawnSync("claude", ["--version"], {
      timeout: 3000,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Step 1: Provider setup
// ---------------------------------------------------------------

interface ProviderStepResult {
  ok: boolean;
  kind?: "ollama" | "openrouter" | "claude";
  envVar?: string;
  // claude only: true when the subscription / CLI-session auth path
  // was selected (no api_key_env written). False / undefined means
  // either a non-claude provider or the API-key flow was used.
  claudeUsesSubscription?: boolean;
  reason?: string;
}

export interface StepProviderOptions {
  // Inject `claude` CLI availability for tests. Defaults to a real
  // `claude --version` probe via spawnSync.
  claudeAvailable?: () => boolean;
}

export async function stepProvider(
  prompt: PromptFn,
  write: WriteFn,
  rootDir: string,
  opts?: StepProviderOptions,
): Promise<ProviderStepResult> {
  write(PROVIDER_INTRO);

  // Check existing config first; if a registry is already wired,
  // the user can skip this step.
  const registry = await loadProviderRegistry(
    join(rootDir, "provider_config.yaml"),
  );
  if (registry.providers.size > 0) {
    write(
      `\nGood news, Commander — provider_config.yaml is already wired with ${registry.providers.size} provider(s).`,
    );
    const skip = await prompt(
      "Use the existing config and skip provider setup?",
      "y",
    );
    if (isYes(skip)) {
      // Pick the first kind for downstream display purposes.
      const first = Array.from(registry.providers.values())[0];
      return { ok: true, kind: first.kind, envVar: first.api_key_env };
    }
    write("\nOverwriting existing provider_config.yaml.");
  }

  const choice = await prompt(
    "Which provider? (ollama / openrouter / claude)",
    "openrouter",
  );
  const kind = choice.trim().toLowerCase();
  if (kind !== "ollama" && kind !== "openrouter" && kind !== "claude") {
    return {
      ok: false,
      reason: `Unknown provider kind '${choice}'. Choose ollama, openrouter, or claude.`,
    };
  }

  let envVar: string | undefined;
  let model: string;
  let host: string | undefined;
  let claudeUsesSubscription = false;

  if (kind === "ollama") {
    write(
      "\nOllama runs locally — make sure the Ollama daemon is running on this machine before continuing.",
    );
    write(
      "If you haven't installed Ollama yet, get it from https://ollama.com and run `ollama pull llama3.1` first.",
    );
    host = await prompt("Ollama host URL?", "http://localhost:11434");
    model = await pickModel(prompt, write, OLLAMA_MODELS);
  } else if (kind === "openrouter") {
    write(
      "\nGet a free API key at https://openrouter.ai (sign in, click your profile -> Keys -> Create Key).",
    );
    write(
      "Set it in your shell: `export OPENROUTER_API_KEY=sk-or-v1-...` (or add to your shell rc file).",
    );
    envVar = await prompt(
      "Which environment variable holds the key?",
      "OPENROUTER_API_KEY",
    );
    if (!process.env[envVar]) {
      write(
        `\nWarning: \$${envVar} is not set in this shell. The wizard will still write the config, but the cycle will fail until the env var is exported. Set it and re-run \`gs welcome\` if needed.`,
      );
    }
    model = await pickModel(prompt, write, OPENROUTER_MODELS);
  } else {
    // claude provider — two auth paths:
    //   subscription: existing `claude` CLI session (Pro / Max). No
    //                 API key needed. The cycle's reviewer + engineer
    //                 spawn `claude -p` directly, which inherits the
    //                 user's logged-in session. This is the path the
    //                 vast majority of Claude Code users actually
    //                 want — and the path the wizard previously
    //                 omitted, locking subscribers out of step 1.
    //   api_key:      separate Anthropic console key in env var.
    //                 For users without a subscription, or who want
    //                 per-token billing instead of flat-rate.
    const isClaudeAvailable = opts?.claudeAvailable ?? claudeCliAvailable;
    const cliAvailable = isClaudeAvailable();

    if (cliAvailable) {
      write(
        "\nGood news, Commander — `claude` is on your PATH. Two ways to authenticate:",
      );
      write(
        "  1. Subscription   Use your existing Claude Code session (Pro / Max). No API key.",
      );
      write(
        "  2. API key        Direct Anthropic API access. Per-token billing, separate from any subscription.",
      );
      const authChoice = await prompt(
        "Which? (1 = subscription / 2 = API key)",
        "1",
      );
      claudeUsesSubscription =
        authChoice.trim() === "1" || /^sub/i.test(authChoice.trim());
    } else {
      write(
        "\nHeads-up: `claude` CLI not detected on PATH. If you have a Claude Pro or Max subscription, installing Claude Code (https://claude.com/code) gives you a no-API-key path. Continuing with the API-key flow.",
      );
      claudeUsesSubscription = false;
    }

    if (claudeUsesSubscription) {
      write(
        "\nUsing your authed Claude Code session. The cycle will spawn `claude -p` directly — auth is inherited from the existing CLI session, no API key required.",
      );
      // envVar stays undefined so api_key_env is omitted from the config.
    } else {
      write(
        "\nGet an Anthropic API key at https://console.anthropic.com (sign in -> Settings -> API Keys).",
      );
      write(
        "Set it in your shell: `export ANTHROPIC_API_KEY=sk-ant-...`.",
      );
      envVar = await prompt(
        "Which environment variable holds the key?",
        "ANTHROPIC_API_KEY",
      );
      if (!process.env[envVar]) {
        write(
          `\nWarning: \$${envVar} is not set in this shell. The wizard will still write the config, but the cycle will fail until the env var is exported.`,
        );
      }
    }

    model = await pickModel(prompt, write, CLAUDE_MODELS);
  }

  // Write provider_config.yaml. Format matches what
  // loadProviderRegistry expects.
  const id = `${kind}-default`;
  const lines: string[] = [
    "# GeneralStaff provider config — written by `gs welcome`.",
    "# See docs/PROVIDERS.md for the full schema and routing options.",
    "",
    "providers:",
    `  - id: ${id}`,
    `    kind: ${kind}`,
    `    model: ${model}`,
  ];
  if (host) lines.push(`    host: ${host}`);
  if (envVar) lines.push(`    api_key_env: ${envVar}`);
  lines.push("");
  lines.push("routes:");
  lines.push(`  digest: ${id}`);
  lines.push(`  cycle_summary: ${id}`);
  lines.push(`  classifier: ${id}`);
  lines.push("");

  const configPath = join(rootDir, "provider_config.yaml");
  writeFileSync(configPath, lines.join("\n"), "utf8");
  write(`\nWrote ${configPath}.`);

  return { ok: true, kind, envVar, claudeUsesSubscription };
}

// ---------------------------------------------------------------
// Step 2: Project setup (bootstrap + auto-move + register)
// ---------------------------------------------------------------

interface ProjectStepResult {
  ok: boolean;
  projectId?: string;
  projectPath?: string;
  reason?: string;
}

export async function stepProject(
  prompt: PromptFn,
  write: WriteFn,
): Promise<ProjectStepResult> {
  write(PROJECT_INTRO);

  const rawPath = await prompt(
    "Path to the project folder you want to register",
  );
  if (!rawPath || rawPath.trim().length === 0) {
    return { ok: false, reason: "no project path provided" };
  }
  const projectPath = resolve(rawPath.trim());
  if (!existsSync(projectPath)) {
    return {
      ok: false,
      reason: `Path does not exist: ${projectPath}. Create the folder first or point at an existing one.`,
    };
  }

  const defaultId = basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const projectId = await prompt(
    "Short id for this project (lowercase, alphanumerics + dashes only)",
    defaultId,
  );
  if (!/^[a-z0-9_-]+$/.test(projectId)) {
    return {
      ok: false,
      reason: `Invalid project id '${projectId}'. Use lowercase letters, numbers, dashes, and underscores only.`,
    };
  }

  const idea = await prompt(
    "One-sentence description of what this project is",
    "personal scratch project for trying GeneralStaff",
  );

  const isGit = existsSync(join(projectPath, ".git"));
  let allowNonGit = false;
  if (!isGit) {
    write(
      "\nHeads-up: this folder is not a git repository. The Staff's audit trail relies on git diffs to show what changed each cycle. Without git, you'll see *what* the Staff did but not *which lines changed*.",
    );
    const confirm = await prompt(
      "Continue anyway? (you can `git init` later)",
      "n",
    );
    if (!isYes(confirm)) {
      return {
        ok: false,
        reason:
          "Aborted at non-git confirmation. Run `git init` in the project folder first, or pick a folder that already has a .git/ directory.",
      };
    }
    allowNonGit = true;
  }

  // Bootstrap. This generates .generalstaff-proposal/ + hands_off.yaml
  // staged copy + state/<id>/tasks.json inside the project.
  write("\nLooking at your folder...");
  let bootstrapResult: BootstrapResult;
  try {
    bootstrapResult = await runBootstrap({
      targetDir: projectPath,
      idea,
      projectId,
    });
  } catch (e) {
    return {
      ok: false,
      reason: `Bootstrap failed: ${(e as Error).message}`,
    };
  }
  if (!bootstrapResult.ok) {
    return {
      ok: false,
      reason: `Bootstrap declined: ${bootstrapResult.reason ?? "(unknown reason)"}`,
    };
  }

  if (bootstrapResult.detectedStack) {
    write(
      `Detected stack: ${bootstrapResult.detectedStack.kind}. Engineer command: ${bootstrapResult.detectedStack.engineerCommand}.`,
    );
  }

  // Auto-move hands_off.yaml from staged proposal into project root.
  // Currently a manual step; the wizard automates it for the first-
  // run user.
  const stagedHandsOff = join(
    projectPath,
    ".generalstaff-proposal",
    "hands_off.yaml",
  );
  const rootedHandsOff = join(projectPath, "hands_off.yaml");
  if (existsSync(stagedHandsOff) && !existsSync(rootedHandsOff)) {
    try {
      // Use copy + leave-staged so the proposal directory stays
      // intact for review; equivalent to `mv` but non-destructive.
      const handsOffContent = readFileSync(stagedHandsOff, "utf8");
      writeFileSync(rootedHandsOff, handsOffContent, "utf8");
      write(`Moved hands_off.yaml into ${rootedHandsOff}.`);
    } catch (e) {
      return {
        ok: false,
        reason: `Failed to move hands_off.yaml: ${(e as Error).message}. The Staff is conservative about file moves; you can move it manually and re-run \`gs welcome\`.`,
      };
    }
  }

  // Register.
  write("\nWiring this project into GeneralStaff's projects.yaml...");
  let registerResult: RegisterResult;
  try {
    registerResult = await runRegister({
      projectId,
      projectPath,
      assumeYes: true,
      allowNonGit,
    });
  } catch (e) {
    return {
      ok: false,
      reason: `Register failed: ${(e as Error).message}`,
    };
  }
  if (!registerResult.ok) {
    return {
      ok: false,
      reason: `Register declined: ${registerResult.reason ?? "(unknown reason)"}`,
    };
  }

  write(
    `Wired into ${registerResult.projectsYamlPath ?? "projects.yaml"}.`,
  );

  return { ok: true, projectId, projectPath };
}

// ---------------------------------------------------------------
// Step 2b: Inject a safe starter task
// ---------------------------------------------------------------

const STARTER_TASK_TITLE =
  "Add a brief one-paragraph WELCOME-NOTE.md describing what this project is and what GeneralStaff is configured to do here";

const STARTER_TASK_HANDS_OFF_PATTERNS: string[] = [
  // None — the starter task explicitly writes a new file at the
  // project root, which can't conflict with hands_off patterns
  // unless the user has a wildcard root match (rare).
];

export function injectStarterTask(
  projectPath: string,
  projectId: string,
): { ok: boolean; reason?: string } {
  const tasksPath = join(projectPath, "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) {
    return {
      ok: false,
      reason: `tasks.json not found at ${tasksPath} — bootstrap should have created it.`,
    };
  }
  let tasks: unknown;
  try {
    tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      reason: `Failed to parse tasks.json: ${(e as Error).message}`,
    };
  }
  if (!Array.isArray(tasks)) {
    return {
      ok: false,
      reason: `tasks.json is not an array.`,
    };
  }

  // Add starter task at top of the list with priority 1.
  const starterTask = {
    id: `${projectId}-welcome-001`,
    title: STARTER_TASK_TITLE,
    status: "pending",
    priority: 1,
    expected_touches: ["WELCOME-NOTE.md"],
  };
  // Don't duplicate if the user re-runs the wizard.
  const alreadyHas = (tasks as Array<{ id?: unknown }>).some(
    (t) => t && typeof t === "object" && t.id === starterTask.id,
  );
  if (!alreadyHas) {
    (tasks as unknown[]).unshift(starterTask);
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n", "utf8");
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Step 3: Cycle invocation + audit display
// ---------------------------------------------------------------

interface CycleStepResult {
  ok: boolean;
  cycleRan: boolean;
  reason?: string;
}

export async function stepCycle(
  prompt: PromptFn,
  write: WriteFn,
  options: {
    projectId: string;
    projectPath: string;
    skipCycle?: boolean;
  },
): Promise<CycleStepResult> {
  write(DISPATCH_INTRO);

  const proceed = await prompt(
    "Run the first cycle now?",
    "y",
  );
  if (!isYes(proceed)) {
    return {
      ok: true,
      cycleRan: false,
      reason: "user-declined",
    };
  }

  if (options.skipCycle) {
    write(
      "\n[skipCycle mode — would invoke runSession here in real flow]",
    );
    return { ok: true, cycleRan: false };
  }

  // Invoke the dispatcher via shell (`gs cycle`) rather than calling
  // runSession directly. runSession's option surface is wide
  // (parallel slots, provider config, fleet messages) and a fresh
  // user shouldn't be passing all of those defaults; the CLI
  // invocation already has the right defaults wired.
  write(
    "\nLaunching one cycle on the dispatcher. This may take a few minutes — the Staff handles claude-code subprocess management, verification, and audit logging.",
  );
  write(
    "  (live output below; quit with Ctrl-C if it hangs)",
  );
  write("");

  const { spawnSync } = await import("child_process");
  // Use `bun run src/cli.ts cycle ...` so the wizard works from a
  // dev checkout; in a published install, `gs cycle ...` would be
  // the same effect. We call into the project's own GS to avoid
  // PATH-resolution flakes during onboarding.
  const result = spawnSync(
    process.execPath,
    [
      process.argv[1] ?? "src/cli.ts",
      "cycle",
      "--project",
      options.projectId,
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    return {
      ok: false,
      cycleRan: false,
      reason: `Failed to launch cycle: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    write(
      "\nThe cycle exited with a non-zero status. That's not necessarily failure — the verification gate may have rejected the diff (which is normal during onboarding). Read the audit trail below for details.",
    );
  }

  return { ok: true, cycleRan: true };
}

// ---------------------------------------------------------------
// Step 4: Audit trail display
// ---------------------------------------------------------------

interface AuditStepResult {
  ok: boolean;
  reason?: string;
}

export async function stepAuditDisplay(
  write: WriteFn,
  options: { projectId: string; rootDir: string },
): Promise<AuditStepResult> {
  const progressPath = join(
    options.rootDir,
    "state",
    options.projectId,
    "PROGRESS.jsonl",
  );
  if (!existsSync(progressPath)) {
    write(
      `\nNo PROGRESS.jsonl found at ${progressPath}. The cycle didn't write any audit events — likely it failed before any work was attempted. Look at the cycle output above for the cause.`,
    );
    return { ok: false, reason: "no-progress-jsonl" };
  }

  const raw = readFileSync(progressPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    write(
      "\nPROGRESS.jsonl exists but is empty. Same diagnosis as above.",
    );
    return { ok: false, reason: "empty-progress-jsonl" };
  }

  // Find the most recent cycle_end event (or the last event of any
  // kind if no cycle_end is present).
  type AuditEvent = {
    event?: string;
    verdict?: string;
    [k: string]: unknown;
  };
  const events: AuditEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // Tolerate malformed lines — partial writes during a crash.
    }
  }
  const lastCycleEnd = [...events]
    .reverse()
    .find((e) => e.event === "cycle_end");

  write("\n=== Audit Trail — Your First Dispatch ===\n");

  if (!lastCycleEnd) {
    write(
      `Found ${events.length} audit event(s) in PROGRESS.jsonl, but no cycle_end yet. The cycle is either still running or it crashed before completion.`,
    );
    return { ok: false, reason: "no-cycle-end" };
  }

  const verdict = String(lastCycleEnd.verdict ?? "unknown").toLowerCase();
  const verdictLine = (() => {
    switch (verdict) {
      case "verified":
        return "Verdict: VERIFIED — the Staff did the work, your verification command passed, and the Reviewer agent confirmed the diff matches the task scope. The work is on the bot/work branch in your project.";
      case "rejected":
        return "Verdict: REJECTED — the verification gate caught a problem and rolled back the work. Your project's main branch is unchanged. This is the gate working as designed; nothing slipped through.";
      case "weak":
        return "Verdict: WEAK — the cycle completed but the Reviewer agent flagged that the diff doesn't fully match the stated scope. The work is on the bot/work branch but you should review before merging.";
      default:
        return `Verdict: ${verdict.toUpperCase()} — read the cycle output above for context.`;
    }
  })();
  write(verdictLine);

  // Display additional fields if present.
  if (lastCycleEnd.task_id) {
    write(`Task: ${String(lastCycleEnd.task_id)}`);
  }
  if (typeof lastCycleEnd.duration_seconds === "number") {
    write(`Duration: ${Math.round(lastCycleEnd.duration_seconds)}s`);
  }
  if (lastCycleEnd.reviewer_reason) {
    write(`Reviewer note: ${String(lastCycleEnd.reviewer_reason)}`);
  }
  if (lastCycleEnd.hands_off_violations) {
    write(
      `Hands-off check: ${JSON.stringify(lastCycleEnd.hands_off_violations)}`,
    );
  }

  write(
    `\nFull audit log: ${progressPath}`,
  );
  write(
    `Each event is one JSON line; the dispatcher writes \`cycle_start\`, \`engineer_subprocess_*\`, \`verification_*\`, \`reviewer_*\`, and \`cycle_end\` events for every cycle.`,
  );

  return { ok: true };
}

// ---------------------------------------------------------------
// Step 5: What's next pointer
// ---------------------------------------------------------------

const WHATS_NEXT = `
=== What's Next ===

You've now run one cycle. From here:

  - Edit \`state/<id>/tasks.json\` in your project to add real
    tasks. The Staff picks the highest-priority pending task
    each cycle.

  - Run more cycles with \`gs cycle --project <id>\` (one cycle)
    or \`gs session --project <id>\` (multiple cycles, runs
    until the budget is exhausted or the queue is empty).

  - Register more projects with \`gs welcome\` (run it again)
    or \`gs bootstrap <path> "<idea>"\` followed by
    \`gs register <id> --path=<path>\`.

  - The audit log at \`state/<id>/PROGRESS.jsonl\` is your
    record of every prompt, every diff, every verdict. It's
    in your repo; nothing is hosted by anyone else.

  - For real projects, replace the no-op verification command
    in \`projects.yaml\` with your project's actual test or
    build command. The verification gate is what makes
    autonomous cycles safe; weak verification = weak safety.

Welcome to the General Staff, Commander.
`;

// ---------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------

export async function runWelcome(
  opts: WelcomeOptions = {},
): Promise<WelcomeResult> {
  // Build the default prompt+close pair once for the whole wizard
  // session so a piped stdin (from an answers file) survives across
  // every prompt. Tests that inject promptFn don't need close.
  let cleanupPrompt: (() => void) | undefined;
  let prompt: PromptFn;
  if (opts.promptFn) {
    prompt = opts.promptFn;
  } else {
    const built = makeDefaultPrompt();
    prompt = built.promptFn;
    cleanupPrompt = built.close;
  }
  const write = opts.writeFn ?? defaultWrite;
  const rootDir = opts.rootDirOverride ?? getRootDir();

  const result: WelcomeResult = { ok: false, completedSteps: [] };

  try {
    // Greeting
    write(BANNER);
    write(GREETING);
    const begin = await prompt("Ready to begin?", "y");
    if (!isYes(begin)) {
      write("Briefing aborted. Run `gs welcome` again when ready.");
      result.reason = "user-aborted-greeting";
      return result;
    }
    result.completedSteps.push("greeting");

    // Provider step
    const providerResult = await stepProvider(prompt, write, rootDir);
    if (!providerResult.ok) {
      write(`\nProvider step failed: ${providerResult.reason}`);
      result.reason = providerResult.reason;
      return result;
    }
    result.providerKind = providerResult.kind;
    result.providerEnvVar = providerResult.envVar;
    result.completedSteps.push("provider");

    // Project step
    const projectResult = await stepProject(prompt, write);
    if (!projectResult.ok) {
      write(`\nProject step failed: ${projectResult.reason}`);
      result.reason = projectResult.reason;
      return result;
    }
    result.projectId = projectResult.projectId;
    result.projectPath = projectResult.projectPath;
    result.completedSteps.push("project");

    // Inject starter task
    const starterResult = injectStarterTask(
      projectResult.projectPath!,
      projectResult.projectId!,
    );
    if (!starterResult.ok) {
      write(`\nStarter task injection failed: ${starterResult.reason}`);
      result.reason = starterResult.reason;
      return result;
    }
    result.completedSteps.push("starter-task");

    // Cycle step
    const cycleResult = await stepCycle(prompt, write, {
      projectId: projectResult.projectId!,
      projectPath: projectResult.projectPath!,
      skipCycle: opts.skipCycle,
    });
    if (!cycleResult.ok) {
      write(`\nCycle step failed: ${cycleResult.reason}`);
      result.reason = cycleResult.reason;
      return result;
    }
    result.cycleRan = cycleResult.cycleRan;
    result.completedSteps.push("cycle");

    // Audit display (only if cycle actually ran)
    if (cycleResult.cycleRan) {
      await stepAuditDisplay(write, {
        projectId: projectResult.projectId!,
        rootDir,
      });
      result.completedSteps.push("audit");
    }

    // What's next
    write(WHATS_NEXT);
    result.completedSteps.push("whats-next");
    result.ok = true;
    return result;
  } finally {
    cleanupPrompt?.();
  }
}
