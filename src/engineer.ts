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
import type { ProjectConfig, DispatcherConfig } from "./types";

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

export async function runEngineer(
  project: ProjectConfig,
  cycleId: string,
  config?: DispatcherConfig,
  dryRun: boolean = false,
): Promise<EngineerResult> {
  const cycDir = ensureCycleDir(project.id, cycleId, config);
  const logPath = join(cycDir, "engineer.log");

  await appendProgress(project.id, "engineer_invoked", {
    command: project.engineer_command,
    cycle_budget_minutes: project.cycle_budget_minutes,
    dry_run: dryRun,
  }, cycleId);

  if (dryRun) {
    await writeCycleFile(
      project.id,
      cycleId,
      "engineer.log",
      "[DRY RUN] Would execute: " + project.engineer_command + "\n",
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

  // Expand ${cycle_budget_minutes} in the command
  // SAFETY INVARIANT (security audit 2026-04-19): only numeric or
  // otherwise shell-safe template variables may be substituted into
  // engineer_command here. cycle_budget_minutes is a parsed integer so
  // it's safe. If you add a new template variable whose value comes from
  // user-facing string content (e.g. task title, free-text config), you
  // MUST shell-quote it before substitution — unquoted interpolation
  // into a shell command is a command-injection surface.
  const command = project.engineer_command.replace(
    /\$\{cycle_budget_minutes\}/g,
    String(project.cycle_budget_minutes),
  );

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
