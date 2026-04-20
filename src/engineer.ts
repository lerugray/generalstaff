// GeneralStaff — engineer module (build step 8)
// Subprocess wrapper for engineer_command with streaming capture

import { spawn } from "child_process";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { ensureCycleDir, writeCycleFile } from "./state";
import { appendProgress } from "./audit";
import {
  setActiveEngineerChild,
  clearActiveEngineerChild,
  killChildTree,
} from "./active_engineer";
import type {
  KillableChild,
  KillChildTreeOptions,
} from "./active_engineer";
import type {
  ProjectConfig,
  DispatcherConfig,
  EngineerProvider,
  GreenfieldTask,
} from "./types";
import { buildAiderCommand } from "./engineer_providers/aider";

export interface EngineerResult {
  exitCode: number | null;
  durationSeconds: number;
  timedOut: boolean;
  logPath: string;
}

// Re-exports preserve the public surface for callers (and tests) that
// import these directly from "./engineer". The live registry now lives
// in ./active_engineer so session.ts can reach it without transitively
// importing state.ts / audit.ts (gs-131).
export { killChildTree, getActiveEngineerChild, killActiveEngineer } from "./active_engineer";
export type { KillableChild, KillChildTreeOptions } from "./active_engineer";

// Resolve the final bash command string for a cycle.
//
// Precedence on provider + model (gs-275 added the task-level tier):
//   1. Task override (task.engineer_provider / task.engineer_model)
//   2. Project default (project.engineer_provider / project.engineer_model)
//   3. Built-in default ("claude" / provider-specific model default)
//
// Task-level overrides let a project mix engineers across its task
// queue — e.g. route type/fixture/e2e/CSS tasks to aider+OpenRouter
// for quota-free execution while keeping React component scaffolding
// on claude where it works. The dispatcher peeks at the next
// bot-pickable task upstream of the engineer spawn (see cycle.ts)
// so we know which override applies before the engineer subprocess
// reads tasks.json itself.
//
// The "claude" path uses project.engineer_command verbatim with
// ${cycle_budget_minutes} expanded. Any non-claude provider has GS
// generate the full invocation; engineer_command is ignored there.
//
// SAFETY INVARIANT (security audit 2026-04-19, still applies): only
// numeric or otherwise shell-safe template variables may be substituted
// into engineer_command for the claude path. cycle_budget_minutes is
// a parsed integer so it's safe. Any new template variable whose value
// comes from user-facing string content (task title, free-text config)
// must be shell-quoted before substitution. For non-claude providers,
// the provider module owns escaping of every interpolated value — see
// engineer_providers/aider.ts shellSingleQuote for the pattern.
export function resolveEngineerCommand(
  project: ProjectConfig,
  nextTask?: GreenfieldTask,
): {
  provider: EngineerProvider;
  command: string;
  source: "task" | "project" | "default";
} {
  // Precedence resolution. Track source so the audit log can show where
  // the provider choice came from — useful when diagnosing why one cycle
  // used aider and the next used claude.
  let provider: EngineerProvider;
  let source: "task" | "project" | "default";
  if (nextTask?.engineer_provider) {
    provider = nextTask.engineer_provider;
    source = "task";
  } else if (project.engineer_provider) {
    provider = project.engineer_provider;
    source = "project";
  } else {
    provider = "claude";
    source = "default";
  }

  // Model override follows the same precedence but is applied by the
  // provider module itself (it reads project.engineer_model). For the
  // task-level model override to take effect we synthesize a project
  // config with the task's model overlaid. Claude path doesn't honor
  // engineer_model (the model is inside the project's own wrapper
  // script), so the overlay is only meaningful for non-claude paths.
  const effectiveProject: ProjectConfig =
    nextTask?.engineer_model
      ? { ...project, engineer_model: nextTask.engineer_model }
      : project;

  switch (provider) {
    case "claude":
      return {
        provider,
        source,
        command: project.engineer_command.replace(
          /\$\{cycle_budget_minutes\}/g,
          String(project.cycle_budget_minutes),
        ),
      };
    case "aider":
      return {
        provider,
        source,
        command: buildAiderCommand(effectiveProject),
      };
  }
}

export async function runEngineer(
  project: ProjectConfig,
  cycleId: string,
  config?: DispatcherConfig,
  dryRun: boolean = false,
  nextTask?: GreenfieldTask,
): Promise<EngineerResult> {
  const cycDir = ensureCycleDir(project.id, cycleId, config);
  const logPath = join(cycDir, "engineer.log");

  const { provider, command, source } = resolveEngineerCommand(project, nextTask);

  await appendProgress(project.id, "engineer_invoked", {
    provider,
    provider_source: source,
    command: provider === "claude" ? project.engineer_command : "(generated by provider module)",
    engineer_model: nextTask?.engineer_model ?? project.engineer_model,
    task_override: nextTask?.engineer_provider !== undefined,
    peeked_task_id: nextTask?.id,
    cycle_budget_minutes: project.cycle_budget_minutes,
    dry_run: dryRun,
  }, cycleId);

  if (dryRun) {
    await writeCycleFile(
      project.id,
      cycleId,
      "engineer.log",
      `[DRY RUN] provider=${provider}\nWould execute:\n${command}\n`,
      config,
    );
    await appendProgress(project.id, "engineer_completed", {
      exit_code: 0,
      duration_seconds: 0,
      timed_out: false,
      dry_run: true,
    }, cycleId);
    return { exitCode: 0, durationSeconds: 0, timedOut: false, logPath };
  }

  const timeoutMs = (project.cycle_budget_minutes + 5) * 60 * 1000;
  const startTime = Date.now();

  return new Promise<EngineerResult>((resolve) => {
    const logStream = createWriteStream(logPath, { flags: "w" });
    logStream.write(`=== GeneralStaff Engineer ===\n`);
    logStream.write(`Command: ${command}\n`);
    logStream.write(`CWD: ${project.path}\n`);
    logStream.write(`Budget: ${project.cycle_budget_minutes} min\n`);
    logStream.write(`Started: ${new Date().toISOString()}\n`);
    logStream.write(`${"=".repeat(40)}\n\n`);

    const child = spawn("bash", ["-c", command], {
      cwd: project.path,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    setActiveEngineerChild(child);

    child.stdout?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      process.stdout.write(chunk); // stream to console too
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      process.stderr.write(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      logStream.write(
        `\n\n=== TIMED OUT after ${project.cycle_budget_minutes + 5} min ===\n`,
      );
      killChildTree(child);
    }, timeoutMs);

    child.on("close", async (code) => {
      clearTimeout(timer);
      clearActiveEngineerChild(child);
      const durationSeconds = (Date.now() - startTime) / 1000;

      logStream.write(
        `\n${"=".repeat(40)}\n` +
          `Exit code: ${code}\n` +
          `Duration: ${durationSeconds.toFixed(1)}s\n` +
          `Ended: ${new Date().toISOString()}\n`,
      );
      logStream.end();

      await appendProgress(project.id, "engineer_completed", {
        exit_code: code,
        duration_seconds: Math.round(durationSeconds),
        timed_out: timedOut,
      }, cycleId);

      resolve({
        exitCode: code,
        durationSeconds,
        timedOut,
        logPath,
      });
    });

    child.on("error", async (err) => {
      clearTimeout(timer);
      clearActiveEngineerChild(child);
      const durationSeconds = (Date.now() - startTime) / 1000;

      const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      const isPermission = (err as NodeJS.ErrnoException).code === "EACCES";

      logStream.write(`\n=== SPAWN ERROR ===\n`);
      logStream.write(`Command: ${command}\n`);
      logStream.write(`CWD: ${project.path}\n`);
      logStream.write(`Error: ${err.message}\n`);
      if (isNotFound) {
        logStream.write(
          `\nThe command could not be found. Common fixes:\n` +
          `  - Ensure 'bash' is installed and in PATH\n` +
          `  - Check that the engineer_command in projects.yaml is correct\n` +
          `  - Run 'generalstaff doctor' to verify prerequisites\n`,
        );
      } else if (isPermission) {
        logStream.write(
          `\nPermission denied. Common fixes:\n` +
          `  - Make the script executable: chmod +x <script>\n` +
          `  - Check file ownership and permissions in ${project.path}\n`,
        );
      }
      logStream.end();

      console.error(
        `[generalstaff] engineer spawn failed for ${project.id}: ${err.message}` +
        (isNotFound ? " (command not found — run 'generalstaff doctor' to check prerequisites)" : "") +
        (isPermission ? " (permission denied — check script is executable)" : ""),
      );

      await appendProgress(project.id, "engineer_completed", {
        exit_code: null,
        duration_seconds: Math.round(durationSeconds),
        timed_out: false,
        error: err.message,
        command,
      }, cycleId);

      resolve({
        exitCode: null,
        durationSeconds,
        timedOut: false,
        logPath,
      });
    });
  });
}
