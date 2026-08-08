// GeneralStaff — verification module (build step 9)
// Independent verification gate (Hard Rule #6)

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { appendFile } from "fs/promises";
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

// gs-316: customer-facing smoke runs after main verification; shorter
// timeout than the full test suite (browser probes, not 1k+ unit tests).
const CUSTOMER_FACING_SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
// Player-path probes can include endurance loops and heap sampling. Give the
// shipped-artifact gate the same ceiling as the primary verification suite.
const PLAYER_PATH_TIMEOUT_MS = 20 * 60 * 1000;

export function isNoopCommand(command: string): boolean {
  const trimmed = command.trim();
  return NOOP_COMMANDS.some(
    (noop) => trimmed === noop || trimmed.startsWith(noop + " "),
  );
}

function shouldRunCustomerFacingSmoke(project: ProjectConfig): boolean {
  return (
    project.public_facing === true &&
    typeof project.customer_facing_smoke === "string" &&
    project.customer_facing_smoke.trim() !== ""
  );
}

function shouldRunPlayerPath(project: ProjectConfig): boolean {
  return (
    typeof project.player_path_command === "string" &&
    project.player_path_command.trim() !== ""
  );
}

// Substrings shells emit when a command is missing. POSIX shells print
// "command not found"; Windows cmd prints "is not recognized"; busybox
// and some distros print "cannot find".
const COMMAND_NOT_FOUND_PATTERNS = [
  "command not found",
  "is not recognized",
  "cannot find",
];

export function isCommandNotFoundSignature(
  exitCode: number | null,
  stderr: string,
): boolean {
  if (exitCode === 127) return true;
  const lower = stderr.toLowerCase();
  return COMMAND_NOT_FOUND_PATTERNS.some((p) => lower.includes(p));
}

export function formatCommandNotFoundHint(
  command: string,
  projectPath: string,
): string {
  const head = command.trim().split(/\s+/)[0] ?? command.trim();
  return (
    `Verification command '${head}' not found — is the tool installed in ` +
    `${projectPath}? (Try: cd ${projectPath} && ${head})`
  );
}

export interface VerificationResult {
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationSeconds: number;
  logPath: string;
}

interface ShellRunResult {
  exitCode: number | null;
  durationSeconds: number;
  timedOut: boolean;
  spawnError?: string;
}

async function appendShellCommandToLog(
  logPath: string,
  header: string,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellRunResult> {
  const startTime = Date.now();
  let section = `\n\n${header}\n`;
  section += `Command: ${command}\n`;
  section += `CWD: ${cwd}\n`;
  section += `Started: ${new Date().toISOString()}\n`;
  section += `${"=".repeat(40)}\n\n`;
  await appendFile(logPath, section);

  return new Promise<ShellRunResult>((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdoutBuf = "";
    let stderrBuf = "";

    const writeChunk = (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    };
    const writeErrChunk = (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    };

    child.stdout?.on("data", writeChunk);
    child.stderr?.on("data", writeErrChunk);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void appendFile(logPath, "\n\n=== COMMAND TIMED OUT ===\n");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    const finish = async (
      exitCode: number | null,
      opts?: { extraFooter?: string; spawnError?: string },
    ) => {
      clearTimeout(timer);
      const durationSeconds = (Date.now() - startTime) / 1000;
      const output = stdoutBuf + stderrBuf;
      if (output.length > 0) {
        await appendFile(logPath, output);
      }
      let footer =
        `\n${"=".repeat(40)}\n` +
        `Exit code: ${exitCode}\n` +
        `Duration: ${durationSeconds.toFixed(1)}s\n` +
        `Ended: ${new Date().toISOString()}\n`;
      if (opts?.extraFooter) {
        footer += opts.extraFooter;
      }
      await appendFile(logPath, footer);
      resolve({
        exitCode,
        durationSeconds,
        timedOut,
        ...(opts?.spawnError ? { spawnError: opts.spawnError } : {}),
      });
    };

    child.on("close", (code) => {
      void finish(code);
    });

    child.on("error", (err) => {
      // Single resolve: thread spawnError through finish so it reaches
      // the ShellRunResult. The prior .then() form double-resolved the
      // promise and dropped spawnError on the floor.
      void finish(null, {
        extraFooter: `\n=== SPAWN ERROR: ${err.message} ===\n`,
        spawnError: err.message,
      });
    });
  });
}

async function runCustomerFacingSmoke(
  project: ProjectConfig,
  cycleId: string,
  config: DispatcherConfig | undefined,
  logPath: string,
  cwd: string,
): Promise<{
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationSeconds: number;
}> {
  const command = project.customer_facing_smoke!.trim();

  await appendProgress(project.id, "customer_facing_smoke_run", {
    command,
    dry_run: false,
  }, cycleId);

  const run = await appendShellCommandToLog(
    logPath,
    "=== Customer-facing smoke ===",
    command,
    cwd,
    CUSTOMER_FACING_SMOKE_TIMEOUT_MS,
  );

  const outcome: VerificationOutcome =
    run.timedOut || run.spawnError !== undefined || run.exitCode !== 0
      ? "failed"
      : "passed";

  await appendProgress(project.id, "customer_facing_smoke_outcome", {
    outcome,
    exit_code: run.exitCode,
    duration_seconds: Math.round(run.durationSeconds),
    timed_out: run.timedOut,
    ...(run.spawnError ? { error: run.spawnError } : {}),
  }, cycleId);

  return {
    outcome,
    exitCode: run.exitCode,
    durationSeconds: run.durationSeconds,
  };
}

async function runPlayerPath(
  project: ProjectConfig,
  cycleId: string,
  logPath: string,
  cwd: string,
): Promise<{
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationSeconds: number;
}> {
  const command = project.player_path_command!.trim();

  await appendProgress(project.id, "player_path_run", {
    command,
    dry_run: false,
  }, cycleId);

  const run = await appendShellCommandToLog(
    logPath,
    "=== Player-path verification ===",
    command,
    cwd,
    PLAYER_PATH_TIMEOUT_MS,
  );

  const outcome: VerificationOutcome =
    run.timedOut || run.spawnError !== undefined || run.exitCode !== 0
      ? "failed"
      : "passed";

  await appendProgress(project.id, "player_path_outcome", {
    outcome,
    exit_code: run.exitCode,
    duration_seconds: Math.round(run.durationSeconds),
    timed_out: run.timedOut,
    ...(run.spawnError ? { error: run.spawnError } : {}),
  }, cycleId);

  return {
    outcome,
    exitCode: run.exitCode,
    durationSeconds: run.durationSeconds,
  };
}

export async function runVerification(
  project: ProjectConfig,
  cycleId: string,
  config?: DispatcherConfig,
  dryRun: boolean = false,
  cwdOverride?: string,
): Promise<VerificationResult> {
  const cwd = cwdOverride ?? project.path;
  const cycDir = ensureCycleDir(project.id, cycleId, config);
  const logPath = join(cycDir, "verification.log");

  await appendProgress(project.id, "verification_run", {
    command: project.verification_command,
    dry_run: dryRun,
  }, cycleId);

  if (dryRun) {
    let logBody =
      "[DRY RUN] Would execute: " +
      project.verification_command +
      "\n";
    const outcome: VerificationOutcome = isNoopCommand(
      project.verification_command,
    )
      ? "weak"
      : "passed";
    if (outcome === "passed" && shouldRunPlayerPath(project)) {
      logBody +=
        "\n[DRY RUN] Would execute player-path verification: " +
        project.player_path_command +
        "\n";
    }
    if (outcome === "passed" && shouldRunCustomerFacingSmoke(project)) {
      logBody +=
        "\n[DRY RUN] Would execute customer-facing smoke: " +
        project.customer_facing_smoke +
        "\n";
    }
    await writeCycleFile(
      project.id,
      cycleId,
      "verification.log",
      logBody,
      config,
    );
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
  // 20-minute timeout for verification. The original 5-minute cap was
  // written when "it should be fast" — generalstaff's own suite has
  // since grown to 1,579 tests / 47 files and runs in ~6 min on
  // Windows, which SIGKILL'd verification subprocesses mid-run
  // despite tests passing (observed 2026-04-20 work-PC session: all
  // three cycles on gs-276 produced clean diffs + reviewer verdict
  // "verified", rolled back because of exit null). 20 min is ~3x
  // headroom over the current worst case; matches the reviewer's
  // own 10-min / 10-sec typical ratio. Future: promote to a
  // per-project `verification_timeout_minutes` field in
  // ProjectConfig if a project's suite grows past 15 min.
  const timeoutMs = 20 * 60 * 1000;

  return new Promise<VerificationResult>((resolve) => {
    const logStream = createWriteStream(logPath, { flags: "w" });
    logStream.write(`=== GeneralStaff Verification Gate ===\n`);
    logStream.write(`Command: ${project.verification_command}\n`);
    logStream.write(`CWD: ${cwd}\n`);
    logStream.write(`Started: ${new Date().toISOString()}\n`);
    logStream.write(`${"=".repeat(40)}\n\n`);

    const child = spawn("bash", ["-c", project.verification_command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stderrBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      stderrBuf += chunk.toString("utf8");
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

      // When the shell reports command-not-found, the exit-1 / exit-127
      // surface is too cryptic for a fresh user whose project is missing
      // a tool (bun, node, a language runtime). Surface a pointer at the
      // real cause without changing semantics. See gs-261.
      if (
        !timedOut &&
        code !== 0 &&
        isCommandNotFoundSignature(code, stderrBuf)
      ) {
        logStream.write(
          `\n${formatCommandNotFoundHint(project.verification_command, project.path)}\n`,
        );
      }
      await new Promise<void>((finish) => logStream.end(finish));

      let outcome: VerificationOutcome =
        timedOut || code !== 0 ? "failed" : "passed";
      let exitCode: number | null = code;
      let totalDurationSeconds = durationSeconds;

      if (outcome === "passed" && shouldRunPlayerPath(project)) {
        const playerPath = await runPlayerPath(
          project,
          cycleId,
          logPath,
          cwd,
        );
        outcome = playerPath.outcome;
        exitCode = playerPath.exitCode;
        totalDurationSeconds += playerPath.durationSeconds;
      }

      if (outcome === "passed" && shouldRunCustomerFacingSmoke(project)) {
        const smoke = await runCustomerFacingSmoke(
          project,
          cycleId,
          config,
          logPath,
          cwd,
        );
        outcome = smoke.outcome;
        exitCode = smoke.exitCode;
        totalDurationSeconds += smoke.durationSeconds;
      }

      await appendProgress(project.id, "verification_outcome", {
        outcome,
        exit_code: exitCode,
        duration_seconds: Math.round(totalDurationSeconds),
        timed_out: timedOut,
      }, cycleId);

      resolve({
        outcome,
        exitCode,
        durationSeconds: totalDurationSeconds,
        logPath,
      });
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
