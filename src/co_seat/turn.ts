// GeneralStaff — co-seats: one bounded agent turn (DESIGN.md §v11 driver steps 6-7).
//
// Snapshots the state file, writes EVENTS.md and PROMPT.md, spawns the runner's
// argv (own process group on POSIX) with `{prompt}` substituted, watches for a
// stop and for the turn timeout, kills the whole process tree on either, then
// checks the state file still has its six headings and restores the snapshot
// if not.

import { spawn, spawnSync } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname } from "os";
import { basename, join } from "path";
import { resolveExecutable } from "../aides";
import { killProcessTree } from "../safety";
import type { CoSeatRunnerConfig } from "../types";
import {
  LOCAL_STOP_CHECK_MS,
  REMOTE_STOP_CHECK_MS,
  REQUIRED_STATE_HEADINGS,
  missingStateHeadings,
  type SeatContext,
} from "./config";
import { writeFileAtomic } from "./control";
import { eventsMarkdown } from "./events";

export type TurnEndReason = "exit" | "timeout" | "stop" | "spawn_error";

export interface TurnResult {
  n: number;
  runner: string;
  meterPercent: number;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  endReason: TurnEndReason;
  /** Why the turn was stopped (the check's answer) when endReason is "stop". */
  stopDetail?: string;
  stateRestored: boolean;
  /** What was wrong with the state file when it was restored. */
  stateIssue?: string;
  /** Set on spawn_error. */
  error?: string;
  promptPath: string;
  eventsPath: string;
}

export interface TurnInput {
  ctx: SeatContext;
  n: number;
  runner: CoSeatRunnerConfig;
  meterPercent: number;
  /** Event and note lines for EVENTS.md. */
  eventLines: string[];
}

export interface TurnDeps {
  /** The parent environment runners map from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** A reason string when the local or fleet STOP says stop; checked every `stopCheckMs`. */
  checkStop?: () => Promise<string | null> | string | null;
  /** A reason string when the remote marker says stop; checked every `remoteCheckMs`. */
  checkRemote?: () => Promise<string | null> | string | null;
  /** Called on every poll (the driver touches its heartbeat here). */
  onPoll?: () => void;
  stopCheckMs?: number;
  remoteCheckMs?: number;
  /** Time between TERM and KILL. Default 5000. */
  killGraceMs?: number;
  /** Override of turn_timeout_seconds (tests). */
  timeoutMs?: number;
}

// --- The live turn record (turn.json): so a dead driver's turn is not orphaned ---

export interface LiveTurnRecord {
  pid: number;
  /** The turn's process group on POSIX (the turn is its own group leader); null on Windows. */
  pgid: number | null;
  host: string;
  started: string;
  n: number;
  /** The executable that was started, to tell a reused pid from the turn. */
  exe: string;
}

export const liveTurnPath = (dir: string) => join(dir, "turn.json");

export function readLiveTurn(dir: string): LiveTurnRecord | null {
  try {
    const o = JSON.parse(readFileSync(liveTurnPath(dir), "utf8")) as Partial<LiveTurnRecord>;
    if (typeof o.pid === "number" && typeof o.host === "string" && typeof o.n === "number") {
      return {
        pid: o.pid,
        pgid: typeof o.pgid === "number" ? o.pgid : null,
        host: o.host,
        started: typeof o.started === "string" ? o.started : "",
        n: o.n,
        exe: typeof o.exe === "string" ? o.exe : "",
      };
    }
  } catch {
    /* none */
  }
  return null;
}

export function clearLiveTurn(dir: string): void {
  rmSync(liveTurnPath(dir), { force: true });
}

/** TERM (or KILL) the turn's whole tree: the process group on POSIX, `taskkill /t` on Windows. */
export function killTurnTree(pid: number, hard: boolean): void {
  const posix = process.platform !== "win32";
  killProcessTree(pid, {
    killFn: posix ? (p) => process.kill(-p, hard ? "SIGKILL" : "SIGTERM") : undefined,
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is `pid` still the turn that was recorded, rather than a reused pid? POSIX: its command line names the recorded executable. */
function looksLikeTurn(rec: LiveTurnRecord): boolean {
  if (process.platform === "win32" || !rec.exe) return true;
  const r = spawnSync("ps", ["-o", "args=", "-p", String(rec.pid)], { encoding: "utf8" });
  if (r.error || r.status === null) return true; // cannot tell: assume it is
  return r.stdout.includes(basename(rec.exe));
}

export type ReapResult =
  | { state: "none" }
  | { state: "stale"; turn: LiveTurnRecord }
  | { state: "killed"; turn: LiveTurnRecord }
  | { state: "elsewhere"; turn: LiveTurnRecord }
  | { state: "survived"; turn: LiveTurnRecord };

export interface ReapDeps {
  host?: string;
  isPidAlive?: (pid: number) => boolean;
  /** Time between TERM and KILL. Default 5000. */
  graceMs?: number;
}

/**
 * Kill a recorded same-host turn that is still alive (its driver died, or the
 * person ran `co-seat stop`), then remove the record. A record from another
 * host cannot be checked or killed from here: it is reported as `elsewhere`
 * and the caller holds turns. `survived` means it would not die.
 */
export async function reapRecordedTurn(dir: string, deps: ReapDeps = {}): Promise<ReapResult> {
  const rec = readLiveTurn(dir);
  if (!rec) {
    if (existsSync(liveTurnPath(dir))) clearLiveTurn(dir); // unreadable record
    return { state: "none" };
  }
  if (rec.host !== (deps.host ?? hostname())) return { state: "elsewhere", turn: rec };
  const alive = deps.isPidAlive ?? pidAlive;
  if (!alive(rec.pid) || !looksLikeTurn(rec)) {
    clearLiveTurn(dir);
    return { state: "stale", turn: rec };
  }
  const graceMs = deps.graceMs ?? 5000;
  killTurnTree(rec.pid, false);
  const until = Date.now() + graceMs;
  while (alive(rec.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  if (alive(rec.pid)) {
    killTurnTree(rec.pid, true);
    const hardUntil = Date.now() + 2000;
    while (alive(rec.pid) && Date.now() < hardUntil) await new Promise((r) => setTimeout(r, 25));
  }
  if (process.platform !== "win32") killTurnTree(rec.pid, true); // stragglers in the group
  if (alive(rec.pid)) return { state: "survived", turn: rec };
  clearLiveTurn(dir);
  return { state: "killed", turn: rec };
}

export function turnDir(seatDirectory: string, n: number): string {
  return join(seatDirectory, "turns", String(n));
}

/** The prompt a turn gets. Short and plain; the rails are in code, not here. */
export function buildPrompt(ctx: SeatContext, n: number, eventsPath: string): string {
  const a = ctx.seat.authority;
  const minutes = Math.max(1, Math.round(ctx.seat.turn_timeout_seconds / 60));
  return [
    `You are co-seat "${ctx.seat.id}", turn ${n}.`,
    "",
    "Read these files in this order:",
    `1. ${ctx.briefPath} (your standing brief)`,
    `2. ${ctx.statePath} (your state: your only memory between turns)`,
    `3. ${eventsPath} (what woke you this turn)`,
    "",
    "Then do what the brief says inside the authority below, rewrite the state file with all six headings, and end your turn.",
    "",
    `Projects you may cycle: ${ctx.seat.projects.join(", ")}.`,
    `Authority: verify ${a.verify ? "yes" : "no"}, land ${a.land ? "yes" : "no"}, park up to ${a.park_per_day} per day, Aide messages up to ${a.aide_messages_per_day} per day.`,
    `GeneralStaff commands enforce these limits. Your turn is stopped after ${minutes} minutes.`,
    "",
  ].join("\n");
}

/** The environment a turn's child gets: parent env, `env` mapped, `env_unset` removed, GS_CO_SEAT_* set last. */
export function buildTurnEnv(
  parent: NodeJS.ProcessEnv,
  runner: CoSeatRunnerConfig,
  seatId: string,
  n: number,
  dir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const [child, source] of Object.entries(runner.env ?? {})) {
    const value = parent[source];
    if (value !== undefined) env[child] = value;
  }
  for (const name of runner.env_unset ?? []) delete env[name];
  env.GS_CO_SEAT = "1";
  env.GS_CO_SEAT_ID = seatId;
  env.GS_CO_SEAT_TURN = String(n);
  env.GS_CO_SEAT_DIR = dir;
  return env;
}

/** argv with `{prompt}` substituted in every arg; `viaStdin` when no arg had the placeholder. */
export function buildArgv(command: string[], prompt: string): { argv: string[]; viaStdin: boolean } {
  let substituted = false;
  const argv = command.map((arg) => {
    if (arg.includes("{prompt}")) {
      substituted = true;
      return arg.split("{prompt}").join(prompt);
    }
    return arg;
  });
  return { argv, viaStdin: !substituted };
}

export async function runTurn(input: TurnInput, deps: TurnDeps = {}): Promise<TurnResult> {
  const { ctx, n, runner } = input;
  const now = deps.now ?? Date.now;
  const posix = process.platform !== "win32";
  const dir = turnDir(ctx.dir, n);
  mkdirSync(dir, { recursive: true });

  const eventsPath = join(dir, "EVENTS.md");
  const promptPath = join(dir, "PROMPT.md");
  const runLog = join(dir, "run.log");
  const runErr = join(dir, "run.err");
  const prompt = buildPrompt(ctx, n, eventsPath);
  writeFileSync(eventsPath, eventsMarkdown(n, new Date(now()).toISOString(), input.eventLines));
  writeFileSync(promptPath, prompt);

  const snapshot = existsSync(ctx.statePath) ? readFileSync(ctx.statePath, "utf8") : null;
  if (snapshot !== null) writeFileSync(join(dir, "STATE.before.md"), snapshot);

  const startedAt = now();
  const finish = (partial: Partial<TurnResult> & Pick<TurnResult, "endReason">): TurnResult => {
    clearLiveTurn(ctx.dir);
    let stateRestored = false;
    let stateIssue: string | undefined;
    const after = existsSync(ctx.statePath) ? readFileSync(ctx.statePath, "utf8") : null;
    const missing = after === null ? [...REQUIRED_STATE_HEADINGS] : missingStateHeadings(after);
    if (missing.length > 0) {
      stateIssue = after === null ? "state file was deleted" : `missing headings: ${missing.join(", ")}`;
      if (snapshot !== null) {
        writeFileAtomic(ctx.statePath, snapshot);
        stateRestored = true;
      }
    }
    return {
      n,
      runner: runner.id,
      meterPercent: input.meterPercent,
      exitCode: null,
      signal: null,
      durationMs: now() - startedAt,
      stateRestored,
      stateIssue,
      promptPath,
      eventsPath,
      ...partial,
    };
  };

  const exe = resolveExecutable(runner.command[0]!, ctx.root);
  if (!exe) {
    const error = `runner "${runner.id}": executable not found: ${runner.command[0]}`;
    writeFileSync(runErr, error + "\n");
    return finish({ endReason: "spawn_error", error });
  }
  const { argv, viaStdin } = buildArgv(runner.command, prompt);
  const env = buildTurnEnv(deps.env ?? process.env, runner, ctx.seat.id, n, ctx.dir);

  const outFd = openSync(runLog, "a");
  const errFd = openSync(runErr, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(exe, argv.slice(1), {
      cwd: ctx.root,
      env,
      shell: false,
      detached: posix, // own process group: a stop kills the whole tree
      windowsHide: true,
      stdio: [viaStdin ? "pipe" : "ignore", outFd, errFd],
    });
  } catch (error) {
    closeSync(outFd);
    closeSync(errFd);
    const message = `runner "${runner.id}": spawn failed: ${(error as Error).message}`;
    writeFileSync(runErr, message + "\n");
    return finish({ endReason: "spawn_error", error: message });
  }
  closeSync(outFd);
  closeSync(errFd);
  // Record the live turn so a dead driver cannot orphan it.
  if (child.pid !== undefined) {
    writeFileAtomic(
      liveTurnPath(ctx.dir),
      JSON.stringify({
        pid: child.pid,
        pgid: posix ? child.pid : null,
        host: hostname(),
        started: new Date().toISOString(),
        n,
        exe,
      } satisfies LiveTurnRecord) + "\n",
    );
  }

  let spawnError: string | undefined;
  let exited = false;
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolvePromise({ code, signal });
    });
    child.once("error", (error) => {
      spawnError = error.message;
      exited = true;
      resolvePromise({ code: null, signal: null });
    });
  });
  if (viaStdin && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  }

  let onKilled: () => void = () => {};
  const kill = (hard: boolean) => {
    const pid = child.pid;
    if (pid === undefined) return;
    killProcessTree(pid, {
      killFn: posix ? (p) => process.kill(-p, hard ? "SIGKILL" : "SIGTERM") : undefined,
    });
  };
  const graceMs = deps.killGraceMs ?? 5000;
  let endReason: TurnEndReason = "exit";
  let stopDetail: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  // After a kill the child gets the grace period plus a little; a child that
  // still has not exited then is abandoned so the turn cannot hang the driver.
  const gaveUp = new Promise<null>((resolvePromise) => {
    onKilled = () => {
      giveUpTimer = setTimeout(() => resolvePromise(null), graceMs + 5000);
    };
  });
  const trigger = (reason: "timeout" | "stop", detail?: string) => {
    if (endReason !== "exit" || exited) return;
    endReason = reason;
    stopDetail = detail;
    kill(false);
    killTimer = setTimeout(() => {
      if (!exited) kill(true);
    }, graceMs);
    onKilled();
  };

  const timeoutMs = deps.timeoutMs ?? ctx.seat.turn_timeout_seconds * 1000;
  const timeoutTimer = setTimeout(() => trigger("timeout"), timeoutMs);

  // In-flight stop checks: local + fleet STOP often, the remote marker less often.
  let polling = true;
  let wakePoller: (() => void) | undefined;
  const nap = (ms: number) =>
    new Promise<void>((resolvePromise) => {
      const t = setTimeout(resolvePromise, ms);
      wakePoller = () => {
        clearTimeout(t);
        resolvePromise();
      };
    });
  const stopEvery = deps.stopCheckMs ?? LOCAL_STOP_CHECK_MS;
  const remoteEvery = deps.remoteCheckMs ?? REMOTE_STOP_CHECK_MS;
  const poller = (async () => {
    let lastRemote = now();
    while (polling && !exited) {
      await nap(stopEvery);
      if (!polling || exited) break;
      try {
        deps.onPoll?.();
        const local = await deps.checkStop?.();
        if (local) return trigger("stop", local);
        if (now() - lastRemote >= remoteEvery) {
          lastRemote = now();
          const remote = await deps.checkRemote?.();
          if (remote) return trigger("stop", remote);
        }
      } catch {
        /* a failing check must not end the turn; the timeout still bounds it */
      }
    }
  })();

  const result = (await Promise.race([exitPromise, gaveUp])) ?? { code: null, signal: null };

  polling = false;
  wakePoller?.();
  clearTimeout(timeoutTimer);
  clearTimeout(killTimer);
  clearTimeout(giveUpTimer);
  await poller.catch(() => {});
  // Whatever the turn left running in its process group dies with it, however it ended.
  if (posix && child.pid !== undefined) kill(true);

  if (spawnError !== undefined) {
    writeFileSync(runErr, `runner "${runner.id}": ${spawnError}\n`, { flag: "a" });
    return finish({ endReason: "spawn_error", error: spawnError });
  }
  return finish({
    endReason,
    stopDetail,
    exitCode: result.code,
    signal: result.signal,
  });
}
