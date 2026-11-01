// GeneralStaff — co-seats: meters and runner choice (DESIGN.md §v11 driver step 5).
//
// A meter is a command that prints a runner's used percent. Fail closed: a
// non-zero exit, a timeout, a spawn error, empty output or anything that is
// not a number from 0 to 100 reads as 100, so a broken meter never grants a turn.

import { spawn } from "child_process";
import { resolveExecutable } from "../aides";
import { killProcessTree } from "../safety";
import { getRootDir } from "../state";
import type { CoSeatRunnerConfig } from "../types";
import { METER_TIMEOUT_MS } from "./config";

export interface MeterReading {
  /** 0-100; 100 whenever `ok` is false. */
  percent: number;
  ok: boolean;
  detail: string;
}

export interface ReadMeterOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_METER_OUTPUT = 64 * 1024;

function fail(detail: string): MeterReading {
  return { percent: 100, ok: false, detail };
}

/** Parse a meter's stdout: a bare number, or JSON `{"used_percent": n}`. */
export function parseMeterOutput(stdout: string): MeterReading {
  const text = stdout.trim();
  if (text === "") return fail("empty output");
  let value: number;
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("output is not a number or JSON");
    }
    const used =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).used_percent
        : undefined;
    if (typeof used !== "number") return fail("JSON output has no numeric used_percent");
    value = used;
  } else if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    value = Number(text);
  } else {
    return fail("output is not a number");
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return fail(`value ${text.slice(0, 40)} is outside 0-100`);
  }
  return { percent: value, ok: true, detail: `used ${value}%` };
}

/** Run a meter command. Never throws and never rejects: every failure reads as 100. */
export function readMeter(argv: string[], opts: ReadMeterOptions = {}): Promise<MeterReading> {
  const timeoutMs = opts.timeoutMs ?? METER_TIMEOUT_MS;
  const cwd = opts.cwd ?? getRootDir();
  return new Promise<MeterReading>((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reading: MeterReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(reading);
    };

    if (!argv.length || !argv[0]) return finish(fail("no meter command"));
    const exe = resolveExecutable(argv[0], cwd);
    if (!exe) return finish(fail(`executable not found: ${argv[0]}`));

    let out = "";
    let child: ReturnType<typeof spawn>;
    const posix = process.platform !== "win32";
    try {
      child = spawn(exe, argv.slice(1), {
        cwd,
        env: opts.env ?? process.env,
        shell: false,
        detached: posix, // own process group, so a timeout can kill the whole tree
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      return finish(fail(`spawn failed: ${(error as Error).message}`));
    }

    timer = setTimeout(() => {
      const pid = child.pid;
      if (pid !== undefined) {
        killProcessTree(pid, {
          killFn: posix ? (p) => process.kill(-p, "SIGKILL") : undefined,
        });
      }
      child.stdout?.destroy();
      finish(fail(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < MAX_METER_OUTPUT) out += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(fail(`spawn failed: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        return finish(fail(signal ? `killed by ${signal}` : `exited ${code}`));
      }
      finish(parseMeterOutput(out));
    });
  });
}

export interface RunnerAttempt {
  runner: string;
  /** Set when the runner was passed over without reading its meter. */
  skipped?: string;
  reading?: MeterReading;
}

export type PickResult =
  | { runner: CoSeatRunnerConfig; reading: MeterReading; readings: RunnerAttempt[] }
  | { runner: null; readings: RunnerAttempt[] };

/**
 * First runner whose meter reads strictly under its `max_used_percent` and
 * whose `env` source variables are all set and non-empty in `env`. A runner
 * with an unset source variable is skipped without running its meter.
 * Runners are re-picked before every turn, so a fallback hands back on its own.
 */
export async function pickRunner(
  runners: CoSeatRunnerConfig[],
  read: (argv: string[]) => Promise<MeterReading>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PickResult> {
  const readings: RunnerAttempt[] = [];
  for (const runner of runners) {
    const missing = Object.values(runner.env ?? {}).filter((source) => !env[source]);
    if (missing.length > 0) {
      readings.push({ runner: runner.id, skipped: `env source ${missing.join(", ")} is unset or empty` });
      continue;
    }
    const reading = await read(runner.meter.command);
    readings.push({ runner: runner.id, reading });
    if (reading.ok && reading.percent < runner.meter.max_used_percent) {
      return { runner, reading, readings };
    }
  }
  return { runner: null, readings };
}
