// Verification stage for `cycle verify`.
//
// Runs the project's own verification command in the materialized tree, and
// then the project's optional player-path, claim-battery and customer-facing
// smoke stages when they are configured (the same gate sequence and the same
// pass rule as the autonomous cycle's verification gate). Each command runs
// as an owned process group under one shared time budget, with a pinned
// environment. The output is redacted once and written to verification.log.

import { writeFile } from "fs/promises";
import { join } from "path";
import { appendProgress } from "../audit";
import { redactSecretsSafe } from "../secrets";
import type { ProjectConfig, VerificationOutcome } from "../types";
import {
  formatCommandNotFoundHint,
  isCommandNotFoundSignature,
  isNoopCommand,
} from "../verification";
import { minimalChildEnv } from "./git";
import { runOwnedShell, type RunnerOptions, type RunnerResult } from "./runner";

export interface VerifyStageResult {
  label: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  reapError?: string;
  durationSeconds: number;
  reaped: boolean;
}

export interface VerifyVerificationResult {
  outcome: VerificationOutcome;
  /** Exit code of the deciding stage (the first that failed, else the last). */
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Every stage ran to completion and every process group was proven reaped. */
  reaped: boolean;
  durationSeconds: number;
  failedStage: string | null;
  spawnError?: string;
  reapError?: string;
  logPath: string;
  /** The redacted log text, as written to logPath. */
  logText: string;
}

const NAMES_TO_PASS_THROUGH = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The environment a verification command runs in: the small pinned set plus
 * any variables the operator names in GENERALSTAFF_VERIFY_ENV_PASSTHROUGH
 * (comma separated). Reviewer credentials and every other variable of the
 * calling process stay out unless named there.
 */
export function verificationEnv(cycleId: string): Record<string, string> {
  const env = minimalChildEnv({
    GENERALSTAFF_VERIFY_ONLY: "1",
    GENERALSTAFF_CYCLE_ID: cycleId,
  });
  const named = (process.env.GENERALSTAFF_VERIFY_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => NAMES_TO_PASS_THROUGH.test(s));
  for (const name of named) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface Stage {
  label: string;
  command: string;
  eventPrefix: "verification" | "player_path" | "claim_battery" | "customer_facing_smoke";
}

function stagesFor(project: ProjectConfig): Stage[] {
  const stages: Stage[] = [
    {
      label: "Verification",
      command: project.verification_command,
      eventPrefix: "verification",
    },
  ];
  if (project.player_path_command?.trim()) {
    stages.push({
      label: "Player-path verification",
      command: project.player_path_command.trim(),
      eventPrefix: "player_path",
    });
  }
  if (project.claim_battery_command?.trim()) {
    stages.push({
      label: "Claim-battery verification",
      command: project.claim_battery_command.trim(),
      eventPrefix: "claim_battery",
    });
  }
  if (project.public_facing === true && project.customer_facing_smoke?.trim()) {
    stages.push({
      label: "Customer-facing smoke",
      command: project.customer_facing_smoke.trim(),
      eventPrefix: "customer_facing_smoke",
    });
  }
  return stages;
}

export async function runVerifyOnlyVerification(args: {
  project: ProjectConfig;
  cycleId: string;
  cwd: string;
  cycleDirPath: string;
  budgetMs: number;
  graceMs: number;
  signal?: AbortSignal;
  /** Test seam: replaces the owned shell runner. */
  runShell?: (opts: RunnerOptions) => Promise<RunnerResult>;
}): Promise<VerifyVerificationResult> {
  const { project, cycleId, cwd } = args;
  const logPath = join(args.cycleDirPath, "verification.log");
  const started = performance.now();
  const remaining = () => args.budgetMs - (performance.now() - started);
  const env = verificationEnv(cycleId);
  const stages = stagesFor(project);

  let log = "=== GeneralStaff Verification Gate (verify-only) ===\n";
  let outcome: VerificationOutcome = "passed";
  let exitCode: number | null = 0;
  let timedOut = false;
  let aborted = false;
  let allReaped = true;
  let failedStage: string | null = null;
  let spawnError: string | undefined;
  let reapError: string | undefined;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const isPrimary = i === 0;
    log += `\n${isPrimary ? "" : `=== ${stage.label} ===\n`}Command: ${stage.command}\n`;
    log += `CWD: ${cwd}\nStarted: ${new Date().toISOString()}\n${"=".repeat(40)}\n\n`;

    await appendProgress(
      project.id,
      isPrimary ? "verification_run" : (`${stage.eventPrefix}_run` as "player_path_run"),
      { command: stage.command, dry_run: false, verify_only: true },
      cycleId,
    );

    if (isPrimary && isNoopCommand(stage.command)) {
      log +=
        "Verification command is effectively a no-op; flagging as verified_weak.\n";
      outcome = "weak";
      exitCode = 0;
      continue;
    }

    if (args.signal?.aborted) {
      aborted = true;
      outcome = "failed";
      exitCode = null;
      failedStage = stage.label;
      break;
    }
    const budget = remaining();
    if (budget <= 0) {
      timedOut = true;
      outcome = "failed";
      exitCode = null;
      failedStage = stage.label;
      log += "\n=== VERIFICATION TIME BUDGET EXHAUSTED BEFORE THIS STAGE ===\n";
      break;
    }

    const run = await (args.runShell ?? runOwnedShell)({
      command: stage.command,
      cwd,
      env,
      timeoutMs: budget,
      graceMs: args.graceMs,
      signal: args.signal,
    });
    log += run.output;
    if (run.timedOut) log += "\n\n=== COMMAND TIMED OUT ===\n";
    if (run.aborted) log += "\n\n=== COMMAND ABORTED ===\n";
    if (run.reapError) log += `\n=== REAP ERROR: ${run.reapError} ===\n`;
    if (run.spawnError) log += `\n=== SPAWN ERROR: ${run.spawnError} ===\n`;
    log +=
      `\n${"=".repeat(40)}\nExit code: ${run.exitCode}\n` +
      `Duration: ${run.durationSeconds.toFixed(1)}s\nEnded: ${new Date().toISOString()}\n`;
    if (
      !run.timedOut &&
      !run.aborted &&
      run.exitCode !== 0 &&
      isCommandNotFoundSignature(run.exitCode, run.output)
    ) {
      log += `\n${formatCommandNotFoundHint(stage.command, cwd)}\n`;
    }
    allReaped = allReaped && run.reaped;

    const stageOutcome: VerificationOutcome =
      !run.reaped || run.timedOut || run.aborted || run.spawnError !== undefined || run.exitCode !== 0
        ? "failed"
        : "passed";
    // REAL #2: a process group that was not proven reaped fails the stage,
    // whatever the exit code said. A surviving group can still be running
    // arbitrary commands against operator state; it must never read as a pass.
    const unreaped = !run.reaped;
    if (unreaped) {
      log += "\n=== PROCESS TREE NOT PROVEN REAPED; FAILING THIS STAGE ===\n";
    }
    if (!isPrimary) {
      await appendProgress(
        project.id,
        `${stage.eventPrefix}_outcome` as "player_path_outcome",
        {
          outcome: stageOutcome,
          exit_code: run.exitCode,
          duration_seconds: Math.round(run.durationSeconds),
          timed_out: run.timedOut,
          ...((run.reapError ?? run.spawnError) ? { error: run.reapError ?? run.spawnError } : {}),
        },
        cycleId,
      );
    }
    exitCode = run.exitCode;
    timedOut = timedOut || run.timedOut;
    aborted = aborted || run.aborted;
    if (stageOutcome === "failed" || unreaped) {
      outcome = "failed";
      failedStage = stage.label;
      spawnError = run.spawnError;
      reapError = run.reapError;
      break;
    }
  }

  const scan = redactSecretsSafe(log);
  const logText = scan.warning ? `${scan.warning}\n${scan.redacted}` : scan.redacted;
  await writeFile(logPath, logText, "utf8");

  const durationSeconds = (performance.now() - started) / 1000;
  await appendProgress(
    project.id,
    "verification_outcome",
    {
      outcome,
      exit_code: exitCode,
      duration_seconds: Math.round(durationSeconds),
      timed_out: timedOut,
      verify_only: true,
      ...(failedStage ? { failed_stage: failedStage } : {}),
      ...((reapError ?? spawnError) ? { error: reapError ?? spawnError } : {}),
    },
    cycleId,
  );

  return {
    outcome,
    exitCode,
    timedOut,
    aborted,
    reaped: allReaped,
    durationSeconds,
    failedStage,
    spawnError,
    reapError,
    logPath,
    logText,
  };
}
