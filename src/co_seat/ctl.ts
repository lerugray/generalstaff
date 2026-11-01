// GeneralStaff — co-seats: the operator commands (DESIGN.md §v11 "Commands").
//
// init, go, extend, stop, status, watchdog and startDetached. These functions
// return data and throw one plain-line Error on a refusal; src/cli.ts prints.

import { spawn } from "child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { isStopFilePresent } from "../safety";
import { CO_SEAT_DEFAULTS, pinOfContext, type SeatContext } from "./config";
import {
  clearGo,
  clearStop,
  defaultGit,
  defaultGitAsync,
  localStopPresent,
  readExit,
  readGo,
  readRemoteControl,
  setRemoteMarkers,
  writeGo,
  writeStop,
  type ExitRecord,
  type GitRunner,
  type GitRunnerAsync,
  type GoMarker,
  type RemoteState,
} from "./control";
import { driverLogPath, readTurnRecords, type TurnRecord } from "./driver";
import { heartbeatAgeMs, lockState, type LockDeps } from "./lock";
import { dailyUse } from "./park";
import { inCoSeat } from "./guards";
import { reapRecordedTurn, type ReapDeps, type ReapResult } from "./turn";

export interface CtlDeps {
  now?: () => number;
  git?: GitRunner;
  gitAsync?: GitRunnerAsync;
  /** Kill-grace and host for reaping a recorded turn (tests). */
  reap?: ReapDeps;
  env?: NodeJS.ProcessEnv;
  lock?: LockDeps;
  /** Start the driver detached; returns its pid. Default: spawn `bun src/cli.ts co-seat run`. */
  spawnDriver?: (ctx: SeatContext) => number | undefined;
  /** Where the templates live (tests). Default: examples/co-seat/ in this checkout. */
  examplesDir?: string;
}

const DAY_MS = 86_400_000;

function refuseInsideSeat(what: string, deps: CtlDeps): void {
  if (inCoSeat(deps.env)) {
    throw new Error(`co-seat ${what} is not allowed inside a co-seat turn (GS_CO_SEAT=1)`);
  }
}

function checkDays(days: number | undefined, fallback: number): number {
  const d = days === undefined ? fallback : days;
  if (!Number.isInteger(d) || d < 1) throw new Error("--days must be a whole number of days, at least 1");
  if (d > CO_SEAT_DEFAULTS.max_run_days) {
    throw new Error(`--days is at most ${CO_SEAT_DEFAULTS.max_run_days}; a seat cannot run longer than that on one go`);
  }
  return d;
}

// --- init ---

export interface InitResult {
  written: string[];
  kept: string[];
}

/** Copy the brief, state and Claude Code settings templates to the configured paths. Never overwrites. */
export function initSeat(ctx: SeatContext, deps: CtlDeps = {}): InitResult {
  const examples = deps.examplesDir ?? resolve(import.meta.dir, "..", "..", "examples", "co-seat");
  const targets: Array<[string, string]> = [
    [join(examples, "BRIEF.md"), ctx.briefPath],
    [join(examples, "STATE.md"), ctx.statePath],
    [join(examples, "claude-settings.json"), join(dirname(ctx.briefPath), "claude-settings.json")],
  ];
  for (const [source] of targets) {
    if (!existsSync(source)) throw new Error(`template is missing: ${source}`);
  }
  const result: InitResult = { written: [], kept: [] };
  for (const [source, target] of targets) {
    if (existsSync(target)) {
      result.kept.push(target);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    result.written.push(target);
  }
  return result;
}

// --- watchdog / startDetached ---

export interface WatchdogResult {
  action: "started" | "running" | "skipped";
  reason: string;
  pid?: number;
}

/** Spawn the driver detached with its output appended to driver.log. */
export function startDetached(ctx: SeatContext, extraArgs: string[] = []): number | undefined {
  mkdirSync(ctx.dir, { recursive: true });
  const fd = openSync(driverLogPath(ctx.dir), "a");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GS_CO_SEAT")) delete env[key];
    const cli = resolve(import.meta.dir, "..", "cli.ts");
    const child = spawn(
      process.execPath,
      [cli, "co-seat", "run", "--id", ctx.seat.id, ...extraArgs],
      { cwd: ctx.root, env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
    );
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * Idempotent: inside the deadline, with GO, no local STOP and no live lock,
 * start the driver detached. Meant for a scheduler every few minutes.
 */
export function watchdogSeat(ctx: SeatContext, deps: CtlDeps = {}): WatchdogResult {
  const now = (deps.now ?? Date.now)();
  const go = readGo(ctx.dir);
  if (go.kind === "missing") return { action: "skipped", reason: "no GO marker" };
  if (go.kind === "invalid") return { action: "skipped", reason: go.detail };
  if (localStopPresent(ctx.dir)) return { action: "skipped", reason: "STOP is present" };
  if (now >= Date.parse(go.go.deadline)) return { action: "skipped", reason: "past the deadline" };
  const lock = lockState(ctx.dir, { now: () => now, ...deps.lock });
  if (lock.state === "live") {
    return { action: "running", reason: lock.reason, pid: lock.owner?.pid };
  }
  const pid = (deps.spawnDriver ?? ((c) => startDetached(c)))(ctx);
  return { action: "started", reason: lock.state === "stale" ? `stale lock (${lock.reason})` : "no driver was running", pid };
}

// --- go / extend / stop ---

export interface GoResult {
  go: GoMarker;
  remoteSet: boolean;
  watchdog: WatchdogResult;
  /** A note for the person when remote_control is set but `--remote` was not given. */
  hint?: string;
}

export function goSeat(
  ctx: SeatContext,
  opts: { days?: number; remote?: boolean } = {},
  deps: CtlDeps = {},
): GoResult {
  refuseInsideSeat("go", deps);
  const days = checkDays(opts.days, ctx.seat.run_days);
  const rc = ctx.seat.remote_control;
  if (opts.remote && !rc) {
    throw new Error(`--remote needs remote_control on co-seat "${ctx.seat.id}" in projects.yaml`);
  }
  if (!existsSync(ctx.briefPath)) {
    throw new Error(`brief file is missing (${ctx.seat.brief}); run \`generalstaff co-seat init\` first`);
  }
  if (!existsSync(ctx.statePath)) {
    throw new Error(`state file is missing (${ctx.seat.state_file}); run \`generalstaff co-seat init\` first`);
  }
  const now = (deps.now ?? Date.now)();
  const pin = pinOfContext(ctx);

  // The remote marker first: if it fails, nothing local has changed.
  if (opts.remote && rc) {
    setRemoteMarkers(rc, ctx.root, { go: true, stop: false }, `co-seat ${ctx.seat.id}: go`, deps.git ?? defaultGit);
  }
  mkdirSync(ctx.dir, { recursive: true });
  clearStop(ctx.dir);
  const go: GoMarker = {
    version: 1,
    set_at: new Date(now).toISOString(),
    deadline: new Date(now + days * DAY_MS).toISOString(),
    pin,
    days,
  };
  writeGo(ctx.dir, go);
  const watchdog = watchdogSeat(ctx, deps);
  return {
    go,
    remoteSet: Boolean(opts.remote && rc),
    watchdog,
    hint:
      rc && !opts.remote
        ? "remote_control is set: the driver idles until the remote GO marker exists (use --remote, or commit it yourself)"
        : undefined,
  };
}

/** Move the deadline and nothing else. */
export function extendSeat(
  ctx: SeatContext,
  opts: { days?: number } = {},
  deps: CtlDeps = {},
): GoMarker {
  refuseInsideSeat("extend", deps);
  const days = checkDays(opts.days, ctx.seat.run_days);
  const go = readGo(ctx.dir);
  if (go.kind !== "ok") {
    throw new Error("there is no GO marker to extend (the seat is stopped or was never started); run `generalstaff co-seat go`");
  }
  const now = (deps.now ?? Date.now)();
  const next: GoMarker = {
    ...go.go,
    deadline: new Date(now + days * DAY_MS).toISOString(),
    extended_at: new Date(now).toISOString(),
  };
  writeGo(ctx.dir, next);
  return next;
}

export interface StopResult {
  remoteSet: boolean;
  /** What happened to a recorded turn that was still running (not attempted from inside a turn). */
  reaped?: ReapResult;
}

/** The local half of a stop: write STOP, remove GO. Needs only the seat's directory. */
export function stopLocal(dir: string, now: number = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  writeStop(dir, now);
  clearGo(dir);
}

/**
 * Write STOP and remove GO, kill a recorded turn tree that is still alive on
 * this host, and optionally commit the remote STOP marker. Allowed inside a
 * turn, so a seat can stop itself (the turn is then left to the driver's
 * in-flight check, which kills it within 10 s: a turn must not kill itself
 * before the markers are written). Needs no agent turn.
 */
export async function stopSeat(
  ctx: SeatContext,
  opts: { remote?: boolean } = {},
  deps: CtlDeps = {},
): Promise<StopResult> {
  stopLocal(ctx.dir, (deps.now ?? Date.now)());
  const result: StopResult = { remoteSet: false };
  if (!inCoSeat(deps.env)) result.reaped = await reapRecordedTurn(ctx.dir, deps.reap);
  const rc = ctx.seat.remote_control;
  if (opts.remote) {
    if (!rc) {
      throw new Error(`local STOP written and GO removed, but --remote needs remote_control on co-seat "${ctx.seat.id}"`);
    }
    setRemoteMarkers(rc, ctx.root, { stop: true }, `co-seat ${ctx.seat.id}: stop`, deps.git ?? defaultGit);
    result.remoteSet = true;
  }
  return result;
}

/**
 * Where a stop should land when projects.yaml cannot be validated: the seat
 * directory by best-effort reading of the raw file's `dispatcher.state_dir`
 * (falling back to ./state). `source` says which, for the message to the person.
 */
export function fallbackSeatDir(root: string, id: string): { dir: string; source: string } {
  try {
    const doc = parseYaml(readFileSync(join(root, "projects.yaml"), "utf8")) as
      | { dispatcher?: { state_dir?: unknown } }
      | null;
    const sd = doc?.dispatcher?.state_dir;
    if (typeof sd === "string" && sd.trim() !== "") {
      return {
        dir: join(root, sd, "_co-seat", id),
        source: `dispatcher.state_dir "${sd}" read from the raw projects.yaml`,
      };
    }
    return { dir: join(root, "state", "_co-seat", id), source: "the default ./state (projects.yaml sets no state_dir)" };
  } catch {
    return {
      dir: join(root, "state", "_co-seat", id),
      source: "the default ./state (projects.yaml could not be read at all)",
    };
  }
}

// --- status ---

export interface SeatStatus {
  seat: string;
  live: boolean;
  lock: { state: string; pid?: number; host?: string; started?: string; reason?: string };
  heartbeat_age_seconds: number | null;
  turns: number;
  last_turn: Pick<
    TurnRecord,
    "n" | "runner" | "meter_percent" | "meter_detail" | "exit_code" | "end_reason" | "ended_at" | "state_restored"
  > | null;
  deadline: string | null;
  hours_left: number | null;
  deadline_warning: boolean;
  markers: {
    go: "ok" | "missing" | "invalid";
    stop: boolean;
    fleet_stop: boolean;
    remote?: RemoteState;
  };
  pin: { recorded: string | null; current: string | null; matches: boolean | null };
  parked_today: { used: number; cap: number } | null;
  aide_messages_today: { used: number; cap: number } | null;
  last_exit: ExitRecord | null;
}

export async function seatStatus(ctx: SeatContext, deps: CtlDeps = {}): Promise<SeatStatus> {
  const now = (deps.now ?? Date.now)();
  const lock = lockState(ctx.dir, { now: () => now, ...deps.lock });
  const records = readTurnRecords(ctx.dir);
  const last = records[records.length - 1];
  const go = readGo(ctx.dir);
  let current: string | null = null;
  try {
    current = pinOfContext(ctx);
  } catch {
    current = null;
  }
  const recorded = go.kind === "ok" ? go.go.pin : null;
  const hoursLeft = go.kind === "ok" ? (Date.parse(go.go.deadline) - now) / 3_600_000 : null;
  const use = dailyUse(ctx.dir, now);
  let remote: RemoteState | undefined;
  if (ctx.seat.remote_control) {
    remote = await readRemoteControl(ctx.seat.remote_control, ctx.root, deps.gitAsync ?? defaultGitAsync);
  }
  return {
    seat: ctx.seat.id,
    live: lock.state === "live",
    lock:
      lock.state === "none"
        ? { state: "none" }
        : {
            state: lock.state,
            pid: lock.owner?.pid,
            host: lock.owner?.host,
            started: lock.owner?.started,
            reason: lock.reason,
          },
    heartbeat_age_seconds: (() => {
      const age = heartbeatAgeMs(ctx.dir, now);
      return age === null ? null : Math.round(age / 1000);
    })(),
    turns: records.length,
    last_turn: last
      ? {
          n: last.n,
          runner: last.runner,
          meter_percent: last.meter_percent,
          meter_detail: last.meter_detail,
          exit_code: last.exit_code,
          end_reason: last.end_reason,
          ended_at: last.ended_at,
          state_restored: last.state_restored,
        }
      : null,
    deadline: go.kind === "ok" ? go.go.deadline : null,
    hours_left: hoursLeft === null ? null : Math.round(hoursLeft * 10) / 10,
    deadline_warning: hoursLeft !== null && hoursLeft < 24,
    markers: {
      go: go.kind,
      stop: localStopPresent(ctx.dir),
      fleet_stop: await isStopFilePresent(),
      remote,
    },
    pin: { recorded, current, matches: recorded === null || current === null ? null : recorded === current },
    parked_today: use ? { used: use.park, cap: ctx.seat.authority.park_per_day } : null,
    aide_messages_today: use ? { used: use.aide, cap: ctx.seat.authority.aide_messages_per_day } : null,
    last_exit: readExit(ctx.dir),
  };
}

/** The human-readable form of `co-seat status`. */
export function formatStatus(s: SeatStatus): string {
  const lines: string[] = [];
  const live = s.live
    ? `LIVE (pid ${s.lock.pid ?? "?"} on ${s.lock.host ?? "?"}, heartbeat ${s.heartbeat_age_seconds ?? "?"} s ago)`
    : s.lock.state === "stale"
      ? `not running (stale lock: ${s.lock.reason})`
      : "not running";
  lines.push(`Co-seat ${s.seat}: ${live}`);
  lines.push(`Turns: ${s.turns}`);
  if (s.last_turn) {
    const t = s.last_turn;
    lines.push(
      `Last turn: #${t.n} runner=${t.runner} meter=${t.meter_percent}% exit=${t.exit_code ?? "none"} ended=${t.end_reason} at ${t.ended_at}${t.state_restored ? " (state restored)" : ""}`,
    );
  } else {
    lines.push("Last turn: none yet");
  }
  if (s.deadline) {
    lines.push(
      `Deadline: ${s.deadline} (${s.hours_left} h left)${s.deadline_warning ? "  WARNING: under 24 h; run `generalstaff co-seat extend`" : ""}`,
    );
  } else {
    lines.push("Deadline: none (no GO marker)");
  }
  const remote = s.markers.remote
    ? `, remote ${s.markers.remote.state === "ok" ? `GO ${s.markers.remote.go ? "yes" : "no"} STOP ${s.markers.remote.stop ? "yes" : "no"}` : `unreadable (${s.markers.remote.detail})`}`
    : "";
  lines.push(
    `Markers: GO ${s.markers.go}, STOP ${s.markers.stop ? "present" : "absent"}, fleet STOP ${s.markers.fleet_stop ? "present" : "absent"}${remote}`,
  );
  lines.push(
    `Config pin: ${s.pin.matches === null ? "not recorded or not readable" : s.pin.matches ? "matches" : "CHANGED; turns hold until `generalstaff co-seat go`"}`,
  );
  lines.push(
    `Parked today: ${s.parked_today ? `${s.parked_today.used} of ${s.parked_today.cap}` : "unreadable"}; Aide messages today: ${s.aide_messages_today ? `${s.aide_messages_today.used} of ${s.aide_messages_today.cap}` : "unreadable"}`,
  );
  lines.push(
    s.last_exit
      ? `Last exit: ${s.last_exit.reason} at ${s.last_exit.at}${s.last_exit.detail ? ` (${s.last_exit.detail})` : ""}`
      : "Last exit: none recorded",
  );
  return lines.join("\n");
}
