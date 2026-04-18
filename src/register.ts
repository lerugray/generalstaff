import { existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { getRootDir } from "./state";
import { detectStack, type StackKind } from "./bootstrap";

export interface RegisterOptions {
  projectId: string;
  projectPath: string;
  assumeYes?: boolean;
  priority?: number;
  stack?: StackKind;
  promptFn?: (question: string) => Promise<boolean>;
}

export interface RegisterResult {
  ok: boolean;
  reason?: string;
  appendedYaml?: string;
  skipped?: boolean;
  projectsYamlPath?: string;
}

async function defaultPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function runRegister(
  opts: RegisterOptions,
): Promise<RegisterResult> {
  const rootDir = getRootDir();
  const projectId = opts.projectId;

  if (!projectId || !/^[a-z0-9_-]+$/i.test(projectId)) {
    return {
      ok: false,
      reason: `Project id "${projectId}" invalid. Use alphanumerics, dashes, and underscores only.`,
    };
  }

  const stateDir = join(rootDir, "state", projectId);
  const tasksPath = join(stateDir, "tasks.json");
  if (!existsSync(stateDir) || !existsSync(tasksPath)) {
    return {
      ok: false,
      reason:
        `state/${projectId}/tasks.json not found. Run 'generalstaff bootstrap ${opts.projectPath} "<idea>"' first — ` +
        `it writes state/${projectId}/tasks.json here and a .generalstaff-proposal/ staging dir in the target.`,
    };
  }

  const projectsYamlPath = join(rootDir, "projects.yaml");
  let existingYamlText: string | null = null;
  if (existsSync(projectsYamlPath)) {
    existingYamlText = readFileSync(projectsYamlPath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(existingYamlText);
    } catch (e) {
      return {
        ok: false,
        reason: `Failed to parse existing projects.yaml: ${(e as Error).message}`,
      };
    }
    const obj = parsed as { projects?: unknown } | null;
    if (obj && Array.isArray(obj.projects)) {
      for (const p of obj.projects) {
        if (p && typeof p === "object" && (p as { id?: unknown }).id === projectId) {
          return {
            ok: false,
            reason: `Project id "${projectId}" is already registered in projects.yaml.`,
          };
        }
      }
    }
  }

  const resolvedProjectPath = resolve(opts.projectPath);
  const rootedHandsOff = join(resolvedProjectPath, "hands_off.yaml");
  const stagedHandsOff = join(
    resolvedProjectPath,
    ".generalstaff-proposal",
    "hands_off.yaml",
  );
  let handsOffPath: string;
  if (existsSync(rootedHandsOff)) {
    handsOffPath = rootedHandsOff;
  } else if (existsSync(stagedHandsOff)) {
    handsOffPath = stagedHandsOff;
  } else {
    return {
      ok: false,
      reason:
        `hands_off.yaml not found at ${rootedHandsOff} or ${stagedHandsOff}. ` +
        `Run 'generalstaff bootstrap' to generate the .generalstaff-proposal/ staging dir, ` +
        `then review and move hands_off.yaml into the project root.`,
    };
  }

  let handsOffPatterns: string[];
  try {
    const raw = readFileSync(handsOffPath, "utf8");
    const parsed = parseYaml(raw) as { patterns?: unknown } | null;
    if (
      !parsed ||
      !Array.isArray(parsed.patterns) ||
      parsed.patterns.length === 0
    ) {
      return {
        ok: false,
        reason: `${handsOffPath} has no non-empty 'patterns' array. Hard Rule 5 requires at least one entry.`,
      };
    }
    handsOffPatterns = parsed.patterns.map((p) => String(p));
  } catch (e) {
    return {
      ok: false,
      reason: `Failed to parse ${handsOffPath}: ${(e as Error).message}`,
    };
  }

  const stack = detectStack(resolvedProjectPath, opts.stack);
  const priority = opts.priority ?? 2;

  const snippetLines = [
    `  - id: ${projectId}`,
    `    path: ${resolvedProjectPath}`,
    `    priority: ${priority}`,
    `    engineer_command: "${stack.engineerCommand}"`,
    `    verification_command: "${stack.verifyCommand}"`,
    `    cycle_budget_minutes: 30`,
    `    work_detection: tasks_json`,
    `    concurrency_detection: worktree`,
    `    branch: bot/work`,
    `    auto_merge: false`,
    `    hands_off:`,
    ...handsOffPatterns.map((p) => `      - "${p}"`),
  ];
  const snippet = snippetLines.join("\n") + "\n";

  if (!opts.assumeYes) {
    const prompt = opts.promptFn ?? defaultPrompt;
    const confirmed = await prompt(
      `About to append project "${projectId}" to projects.yaml.\n` +
        `(projects.yaml is in hands_off for the bot, but 'register' is the tool's own\n` +
        ` write path to its own config — equivalent to 'init'.)\n` +
        `Proceed?`,
    );
    if (!confirmed) {
      return {
        ok: false,
        skipped: true,
        reason: "Registration declined.",
        projectsYamlPath,
      };
    }
  }

  if (existingYamlText === null) {
    const newContent = `projects:\n${snippet}`;
    writeFileSync(projectsYamlPath, newContent, "utf8");
  } else {
    const lines = existingYamlText.split("\n");
    let insertAt = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^dispatcher\s*:/.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
    let newContent: string;
    if (insertAt === -1) {
      const tail = existingYamlText.endsWith("\n") ? "" : "\n";
      newContent = existingYamlText + tail + snippet;
    } else {
      const before = lines.slice(0, insertAt).join("\n");
      const after = lines.slice(insertAt).join("\n");
      const beforeSep = before.endsWith("\n") ? "" : "\n";
      newContent = before + beforeSep + snippet + "\n" + after;
    }
    writeFileSync(projectsYamlPath, newContent, "utf8");
  }

  return { ok: true, appendedYaml: snippet, projectsYamlPath };
}
