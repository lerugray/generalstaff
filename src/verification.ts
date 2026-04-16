// GeneralStaff — verification module (build step 9)
// Independent verification gate (Hard Rule #6)

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { join } from "path";
import { ensureCycleDir, writeCycleFile } from "./state";
import { appendProgress } from "./audit";
import type {
  ProjectConfig,
  DispatcherConfig,
  VerificationOutcome,
} from "./types";

// Commands that are effectively no-ops — flag as verified_weak
const NOOP_COMMANDS = ["true", ":", "echo", "exit 0"];

function isNoopCommand(command: string): boolean {
  const trimmed = command.trim();
  return NOOP_COMMANDS.some(
    (noop) => trimmed === noop || trimmed.startsWith(noop + " "),
  );
}

export interface VerificationResult {
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationSeconds: number;
  logPath: string;
}

export async function runVerification(
  project: ProjectConfig,
  cycleId: string,
  config?: DispatcherConfig,
  dryRun: boolean = false,
): Promise<VerificationResult> {
  const cycDir = ensureCycleDir(project.id, cycleId, config);
  const logPath = join(cycDir, "verification.log");

  await appendProgress(project.id, "verification_run", {
    command: project.verification_command,
    dry_run: dryRun,
  }, cycleId);

  if (dryRun) {
    await writeCycleFile(
      project.id,
      cycleId,
      "verification.log",
      "[DRY RUN] Would execute: " +
        project.verification_command +
        "\n",
      config,
    );
    const outcome: VerificationOutcome = isNoopCommand(
      project.verification_command,
    )
      ? "weak"
      : "passed";
    await appendProgress(project.id, "verification_outcome", {
      outcome,
      exit_code: 0,
      dry_run: true,
    }, cycleId);
    return { outcome, exitCode: 0, durationSeconds: 0, logPath };
  }

  // Check for no-op verification commands
  if (isNoopCommand(project.verification_command)) {
    await writeCycleFile(
      project.id,
      cycleId,
      "verification.log",
      "Verification command is effectively a no-op — flagging as verified_weak.\n" +
        `Command: ${project.verification_command}\n`,
      config,
    );
    await appendProgress(project.id, "verification_outcome", {
      outcome: "weak",
      exit_code: 0,
      reason: "no-op verification command",
    }, cycleId);
    return { outcome: "weak", exitCode: 0, durationSeconds: 0, logPath };
  }

  const startTime = Date.now();
  // 5-minute timeout for verification (it should be fast)
  const timeoutMs = 5 * 60 * 1000;

  return new Promise<VerificationResult>((resolve) => {
    const logStream = createWriteStream(logPath, { flags: "w" });
    logStream.write(`=== GeneralStaff Verification Gate ===\n`);
    logStream.write(`Command: ${project.verification_command}\n`);
    logStream.write(`CWD: ${project.path}\n`);
    logStream.write(`Started: ${new Date().toISOString()}\n`);
    logStream.write(`${"=".repeat(40)}\n\n`);

    const child = spawn("bash", ["-c", project.verification_command], {
      cwd: project.path,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      logStream.write("\n\n=== VERIFICATION TIMED OUT ===\n");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.on("close", async (code) => {
      clearTimeout(timer);
      const durationSeconds = (Date.now() - startTime) / 1000;

      logStream.write(
        `\n${"=".repeat(40)}\n` +
          `Exit code: ${code}\n` +
          `Duration: ${durationSeconds.toFixed(1)}s\n` +
          `Ended: ${new Date().toISOString()}\n`,
      );
      logStream.end();

      const outcome: VerificationOutcome =
        timedOut || code !== 0 ? "failed" : "passed";

      await appendProgress(project.id, "verification_outcome", {
        outcome,
        exit_code: code,
        duration_seconds: Math.round(durationSeconds),
        timed_out: timedOut,
      }, cycleId);

      resolve({ outcome, exitCode: code, durationSeconds, logPath });
    });

    child.on("error", async (err) => {
      clearTimeout(timer);
      const durationSeconds = (Date.now() - startTime) / 1000;
      logStream.write(`\n=== SPAWN ERROR: ${err.message} ===\n`);
      logStream.end();

      await appendProgress(project.id, "verification_outcome", {
        outcome: "failed",
        exit_code: null,
        error: err.message,
      }, cycleId);

      resolve({
        outcome: "failed",
        exitCode: null,
        durationSeconds,
        logPath,
      });
    });
  });
}
