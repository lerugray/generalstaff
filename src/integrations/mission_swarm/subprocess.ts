// gs-306: spawn wrapper around `missionswarm run` + `missionswarm
// summarize`. The mission-swarm package is not globally installed —
// invocation is `bun <MISSIONSWARM_ROOT>/src/index.ts <subcommand>`.
// The root path is read from $MISSIONSWARM_ROOT (required). If unset
// the caller (hook.ts) graceful-skips the preview.

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { MissionSwarmInvocation } from "./types";

export interface SubprocessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function resolveMissionSwarmRoot(
  overrideRoot?: string,
): string | null {
  const candidate = overrideRoot ?? process.env.MISSIONSWARM_ROOT;
  if (!candidate) return null;
  if (!existsSync(join(candidate, "src", "index.ts"))) return null;
  return candidate;
}

export async function runMissionSwarmSim(
  invocation: MissionSwarmInvocation,
  opts: {
    outputDir: string;
    simId: string;
    missionswarmRoot: string;
    model?: string;
    timeoutMs?: number;
    spawnFn?: typeof spawn;
  },
): Promise<SubprocessResult> {
  const args = [
    join(opts.missionswarmRoot, "src", "index.ts"),
    "run",
    `--input=${invocation.taskDescription}`,
    `--audience=${invocation.audience}`,
    `--agents=${String(invocation.nAgents)}`,
    `--rounds=${String(invocation.nRounds)}`,
    `--output=${opts.outputDir}`,
    `--simulation-id=${opts.simId}`,
  ];
  if (opts.model) args.push(`--model=${opts.model}`);
  return spawnCapture("bun", args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    spawnFn: opts.spawnFn,
  });
}

export async function runMissionSwarmSummarize(
  opts: {
    simDir: string;
    missionswarmRoot: string;
    model?: string;
    timeoutMs?: number;
    spawnFn?: typeof spawn;
  },
): Promise<SubprocessResult> {
  const args = [
    join(opts.missionswarmRoot, "src", "index.ts"),
    "summarize",
    opts.simDir,
    "--stdout",
  ];
  if (opts.model) args.push(`--model=${opts.model}`);
  return spawnCapture("bun", args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    spawnFn: opts.spawnFn,
  });
}

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; spawnFn?: typeof spawn },
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const spawnImpl = opts.spawnFn ?? spawn;
    const child = spawnImpl(cmd, args, {
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      resolve({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        error: `missionswarm subprocess timed out after ${opts.timeoutMs}ms`,
      });
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        error: err.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
      });
    });
  });
}
