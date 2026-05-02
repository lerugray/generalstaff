// Tests for the `gs welcome` first-run wizard. The wizard drives
// real I/O and composes runBootstrap + runRegister + runSession,
// so most coverage here uses dependency-injected promptFn / writeFn
// to drive the step state machine deterministically. End-to-end
// coverage of the cycle invocation is left to manual testing +
// the existing dispatcher / session test suites.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "path";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import {
  injectStarterTask,
  runWelcome,
  stepProvider,
  stepProject,
  stepCycle,
  stepAuditDisplay,
  type PromptFn,
  type WriteFn,
} from "../src/welcome";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "welcome_test");

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

interface ScriptedPrompt {
  promptFn: PromptFn;
  writeFn: WriteFn;
  output: string[];
  questions: string[];
}

// Build a prompt+write pair that returns scripted answers in order.
// Throws if more questions are asked than answers were provided.
function scriptedIO(answers: string[]): ScriptedPrompt {
  const output: string[] = [];
  const questions: string[] = [];
  let next = 0;
  return {
    output,
    questions,
    promptFn: async (question, defaultAnswer) => {
      questions.push(question);
      if (next >= answers.length) {
        throw new Error(
          `Prompt exhausted: question ${next + 1} '${question}' has no scripted answer (only ${answers.length} provided)`,
        );
      }
      const answer = answers[next++];
      // Empty string => use the default
      if (answer === "" && defaultAnswer !== undefined) return defaultAnswer;
      return answer;
    },
    writeFn: (text) => {
      output.push(text);
    },
  };
}

function makeProjectFixture(id: string): string {
  const projectPath = join(FIXTURE_ROOT, id);
  mkdirSync(projectPath, { recursive: true });
  // Mark as a git repo so register doesn't refuse.
  mkdirSync(join(projectPath, ".git"), { recursive: true });
  return projectPath;
}

// ---------------------------------------------------------------
// stepProvider — exercises the provider config writer
// ---------------------------------------------------------------

describe("stepProvider", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("writes provider_config.yaml with openrouter defaults", async () => {
    const rootDir = join(FIXTURE_ROOT, "openrouter-flow");
    mkdirSync(rootDir, { recursive: true });
    const io = scriptedIO([
      "openrouter", // provider kind
      "OPENROUTER_API_KEY", // env var (default)
      "qwen/qwen3-next-80b-a3b-instruct:free", // model (default)
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("openrouter");
    expect(result.envVar).toBe("OPENROUTER_API_KEY");

    const configPath = join(rootDir, "provider_config.yaml");
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("kind: openrouter");
    expect(content).toContain("model: qwen/qwen3-next-80b-a3b-instruct:free");
    expect(content).toContain("api_key_env: OPENROUTER_API_KEY");
    expect(content).toContain("routes:");
  });

  it("writes provider_config.yaml with ollama defaults", async () => {
    const rootDir = join(FIXTURE_ROOT, "ollama-flow");
    mkdirSync(rootDir, { recursive: true });
    const io = scriptedIO([
      "ollama",
      "http://localhost:11434", // host (default)
      "llama3.1", // model (default)
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ollama");
    expect(result.envVar).toBeUndefined();

    const configPath = join(rootDir, "provider_config.yaml");
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("kind: ollama");
    expect(content).toContain("host: http://localhost:11434");
  });

  it("rejects unknown provider kind", async () => {
    const rootDir = join(FIXTURE_ROOT, "bad-kind");
    mkdirSync(rootDir, { recursive: true });
    const io = scriptedIO(["nonsense-provider"]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unknown provider kind");
  });

  it("offers to skip when an existing config has providers", async () => {
    const rootDir = join(FIXTURE_ROOT, "existing-config");
    mkdirSync(rootDir, { recursive: true });
    // Write a minimal valid config
    writeFileSync(
      join(rootDir, "provider_config.yaml"),
      `providers:\n  - id: existing-default\n    kind: ollama\n    model: llama3.1\nroutes:\n  digest: existing-default\n  cycle_summary: existing-default\n  classifier: existing-default\n`,
      "utf8",
    );
    const io = scriptedIO(["y"]); // skip = yes

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ollama");
    // Asked exactly one question (the skip prompt)
    expect(io.questions.length).toBe(1);
    expect(io.questions[0]).toContain("skip");
  });

  // claude provider — three flows: subscription (CLI on PATH, picks 1),
  // API key chosen explicitly (CLI on PATH, picks 2), and CLI not on
  // PATH (forced into API-key flow). Subscription is the default that
  // unblocks Pro / Max users who don't carry a separate API key.

  it("writes claude config without api_key_env when subscription path is chosen", async () => {
    const rootDir = join(FIXTURE_ROOT, "claude-subscription");
    mkdirSync(rootDir, { recursive: true });
    const io = scriptedIO([
      "claude", // provider kind
      "1", // subscription auth
      "claude-sonnet-4-5", // model (default)
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir, {
      claudeAvailable: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("claude");
    expect(result.envVar).toBeUndefined();
    expect(result.claudeUsesSubscription).toBe(true);

    const content = readFileSync(join(rootDir, "provider_config.yaml"), "utf8");
    expect(content).toContain("kind: claude");
    expect(content).toContain("model: claude-sonnet-4-5");
    // Critical: no api_key_env line. Subscription auth means no env var.
    expect(content).not.toContain("api_key_env");
  });

  it("writes claude config with api_key_env when API-key path is chosen", async () => {
    const rootDir = join(FIXTURE_ROOT, "claude-apikey");
    mkdirSync(rootDir, { recursive: true });
    const io = scriptedIO([
      "claude", // provider kind
      "2", // API key auth
      "ANTHROPIC_API_KEY", // env var (default)
      "claude-sonnet-4-5", // model (default)
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir, {
      claudeAvailable: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("claude");
    expect(result.envVar).toBe("ANTHROPIC_API_KEY");
    expect(result.claudeUsesSubscription).toBe(false);

    const content = readFileSync(join(rootDir, "provider_config.yaml"), "utf8");
    expect(content).toContain("kind: claude");
    expect(content).toContain("api_key_env: ANTHROPIC_API_KEY");
  });

  it("falls through to API-key flow when claude CLI is not on PATH", async () => {
    const rootDir = join(FIXTURE_ROOT, "claude-no-cli");
    mkdirSync(rootDir, { recursive: true });
    // No "1 / 2" prompt is asked because the CLI-absent branch skips
    // the auth-choice question entirely.
    const io = scriptedIO([
      "claude",
      "ANTHROPIC_API_KEY",
      "claude-sonnet-4-5",
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir, {
      claudeAvailable: () => false,
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("claude");
    expect(result.envVar).toBe("ANTHROPIC_API_KEY");
    expect(result.claudeUsesSubscription).toBe(false);

    const content = readFileSync(join(rootDir, "provider_config.yaml"), "utf8");
    expect(content).toContain("api_key_env: ANTHROPIC_API_KEY");
  });

  // pickModel coverage — exercises the numbered-list picker that
  // replaced the previous free-form prompt("Which model?", default).
  // Non-numeric input still works as the "I know the ID I want"
  // escape hatch; numeric input maps to the choices list; one
  // past-the-list triggers the Custom prompt.

  it("writes the selected claude model when user picks a number from the list", async () => {
    const rootDir = join(FIXTURE_ROOT, "claude-numbered");
    mkdirSync(rootDir, { recursive: true });
    // CLAUDE_MODELS order: 1 = opus-4-7 (recommended), 2 = sonnet-4-6,
    // 3 = haiku-4-5, 4 = Custom. Pick "2" -> sonnet-4-6.
    const io = scriptedIO([
      "claude", // provider kind
      "1", // subscription auth
      "2", // model choice -> sonnet
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir, {
      claudeAvailable: () => true,
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("claude");

    const content = readFileSync(join(rootDir, "provider_config.yaml"), "utf8");
    expect(content).toContain("model: claude-sonnet-4-6");
  });

  it("uses the recommended claude model when user accepts the default at the picker", async () => {
    const rootDir = join(FIXTURE_ROOT, "claude-default-model");
    mkdirSync(rootDir, { recursive: true });
    // Empty string at the picker -> default -> recommended idx + 1.
    // Recommended in CLAUDE_MODELS is opus-4-7 (idx 0), so "1".
    const io = scriptedIO([
      "claude", // provider kind
      "1", // subscription auth
      "", // accept default at model picker -> opus-4-7
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir, {
      claudeAvailable: () => true,
    });
    expect(result.ok).toBe(true);
    const content = readFileSync(join(rootDir, "provider_config.yaml"), "utf8");
    expect(content).toContain("model: claude-opus-4-7");
  });

  it("accepts a custom model id when user picks the Custom option", async () => {
    const rootDir = join(FIXTURE_ROOT, "claude-custom-model");
    mkdirSync(rootDir, { recursive: true });
    // 4 of 4 = Custom (CLAUDE_MODELS has 3 entries + Custom slot).
    const io = scriptedIO([
      "claude",
      "1", // subscription
      "4", // Custom
      "claude-experimental-2026-may", // typed ID
    ]);

    const result = await stepProvider(io.promptFn, io.writeFn, rootDir, {
      claudeAvailable: () => true,
    });
    expect(result.ok).toBe(true);
    const content = readFileSync(join(rootDir, "provider_config.yaml"), "utf8");
    expect(content).toContain("model: claude-experimental-2026-may");
  });
});

// ---------------------------------------------------------------
// stepProject — exercises path validation + bootstrap composition
// ---------------------------------------------------------------

describe("stepProject", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("rejects empty project path", async () => {
    const io = scriptedIO([""]);
    const result = await stepProject(io.promptFn, io.writeFn);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no project path");
  });

  it("rejects non-existent path", async () => {
    const io = scriptedIO([
      join(FIXTURE_ROOT, "does-not-exist"),
      "myproj",
      "test idea",
    ]);
    const result = await stepProject(io.promptFn, io.writeFn);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("rejects invalid project id with bad characters", async () => {
    const projectPath = makeProjectFixture("valid-folder");
    const io = scriptedIO([
      projectPath,
      "BAD ID with spaces!", // invalid id
      "test idea",
    ]);
    const result = await stepProject(io.promptFn, io.writeFn);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Invalid project id");
  });
});

// ---------------------------------------------------------------
// injectStarterTask — exercises tasks.json mutation
// ---------------------------------------------------------------

describe("injectStarterTask", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("prepends the starter task to a clean tasks.json", () => {
    const projectPath = makeProjectFixture("starter-clean");
    const stateDir = join(projectPath, "state", "starter-clean");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "tasks.json"),
      JSON.stringify(
        [{ id: "existing-001", title: "existing", status: "pending", priority: 2 }],
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const result = injectStarterTask(projectPath, "starter-clean");
    expect(result.ok).toBe(true);

    const tasksPath = join(stateDir, "tasks.json");
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Array<{
      id: string;
    }>;
    expect(tasks.length).toBe(2);
    expect(tasks[0].id).toBe("starter-clean-welcome-001");
    expect(tasks[1].id).toBe("existing-001");
  });

  it("does not duplicate the starter task on re-injection", () => {
    const projectPath = makeProjectFixture("starter-rerun");
    const stateDir = join(projectPath, "state", "starter-rerun");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "tasks.json"),
      JSON.stringify([], null, 2) + "\n",
      "utf8",
    );

    injectStarterTask(projectPath, "starter-rerun");
    const result = injectStarterTask(projectPath, "starter-rerun");
    expect(result.ok).toBe(true);

    const tasks = JSON.parse(
      readFileSync(join(stateDir, "tasks.json"), "utf8"),
    ) as Array<{ id: string }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("starter-rerun-welcome-001");
  });

  it("fails gracefully when tasks.json is missing", () => {
    const projectPath = makeProjectFixture("starter-no-tasks");
    const result = injectStarterTask(projectPath, "starter-no-tasks");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("tasks.json not found");
  });

  it("fails gracefully when tasks.json is malformed", () => {
    const projectPath = makeProjectFixture("starter-bad-json");
    const stateDir = join(projectPath, "state", "starter-bad-json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "tasks.json"), "{ not valid json", "utf8");

    const result = injectStarterTask(projectPath, "starter-bad-json");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Failed to parse");
  });
});

// ---------------------------------------------------------------
// stepCycle — exercises skipCycle + user-decline paths
// ---------------------------------------------------------------

describe("stepCycle", () => {
  it("returns ok with cycleRan=false when user declines", async () => {
    const io = scriptedIO(["n"]);
    const result = await stepCycle(io.promptFn, io.writeFn, {
      projectId: "x",
      projectPath: "/tmp/x",
    });
    expect(result.ok).toBe(true);
    expect(result.cycleRan).toBe(false);
    expect(result.reason).toBe("user-declined");
  });

  it("returns ok with cycleRan=false in skipCycle mode", async () => {
    const io = scriptedIO(["y"]);
    const result = await stepCycle(io.promptFn, io.writeFn, {
      projectId: "x",
      projectPath: "/tmp/x",
      skipCycle: true,
    });
    expect(result.ok).toBe(true);
    expect(result.cycleRan).toBe(false);
    // Skipped output should mention the test mode
    expect(io.output.some((t) => t.includes("skipCycle"))).toBe(true);
  });
});

// ---------------------------------------------------------------
// stepAuditDisplay — exercises PROGRESS.jsonl reading
// ---------------------------------------------------------------

describe("stepAuditDisplay", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("reports no PROGRESS.jsonl when state dir is empty", async () => {
    const rootDir = join(FIXTURE_ROOT, "audit-empty");
    mkdirSync(rootDir, { recursive: true });
    const io = scriptedIO([]);
    const result = await stepAuditDisplay(io.writeFn, {
      projectId: "x",
      rootDir,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-progress-jsonl");
  });

  it("renders verified verdict with friendly explanation", async () => {
    const rootDir = join(FIXTURE_ROOT, "audit-verified");
    const stateDir = join(rootDir, "state", "myproj");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "PROGRESS.jsonl"),
      JSON.stringify({
        event: "cycle_end",
        verdict: "verified",
        task_id: "myproj-welcome-001",
        duration_seconds: 42,
      }) + "\n",
      "utf8",
    );

    const io = scriptedIO([]);
    const result = await stepAuditDisplay(io.writeFn, {
      projectId: "myproj",
      rootDir,
    });
    expect(result.ok).toBe(true);
    expect(io.output.some((t) => t.includes("VERIFIED"))).toBe(true);
    expect(io.output.some((t) => t.includes("myproj-welcome-001"))).toBe(true);
    expect(io.output.some((t) => t.includes("42s"))).toBe(true);
  });

  it("renders rejected verdict with friendly explanation", async () => {
    const rootDir = join(FIXTURE_ROOT, "audit-rejected");
    const stateDir = join(rootDir, "state", "myproj");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "PROGRESS.jsonl"),
      JSON.stringify({
        event: "cycle_start",
        task_id: "myproj-welcome-001",
      }) +
        "\n" +
        JSON.stringify({
          event: "cycle_end",
          verdict: "rejected",
          reviewer_reason: "diff doesn't match scope",
        }) +
        "\n",
      "utf8",
    );

    const io = scriptedIO([]);
    const result = await stepAuditDisplay(io.writeFn, {
      projectId: "myproj",
      rootDir,
    });
    expect(result.ok).toBe(true);
    expect(io.output.some((t) => t.includes("REJECTED"))).toBe(true);
    expect(io.output.some((t) => t.includes("rolled back"))).toBe(true);
  });

  it("tolerates malformed jsonl lines", async () => {
    const rootDir = join(FIXTURE_ROOT, "audit-malformed");
    const stateDir = join(rootDir, "state", "myproj");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "PROGRESS.jsonl"),
      `{ not valid\n${JSON.stringify({ event: "cycle_end", verdict: "weak" })}\n`,
      "utf8",
    );

    const io = scriptedIO([]);
    const result = await stepAuditDisplay(io.writeFn, {
      projectId: "myproj",
      rootDir,
    });
    expect(result.ok).toBe(true);
    expect(io.output.some((t) => t.includes("WEAK"))).toBe(true);
  });
});

// ---------------------------------------------------------------
// runWelcome (smoke test of the full flow with skipCycle)
// ---------------------------------------------------------------

describe("runWelcome (smoke test)", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("aborts cleanly when user declines the greeting", async () => {
    const io = scriptedIO(["n"]);
    const result = await runWelcome({
      promptFn: io.promptFn,
      writeFn: io.writeFn,
      rootDirOverride: join(FIXTURE_ROOT, "abort-greeting"),
      skipCycle: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("user-aborted-greeting");
    expect(result.completedSteps).toEqual([]);
  });
});
