// GeneralStaff — co-seats: the driver (DESIGN.md §v11 "The driver").
//
// `generalstaff co-seat run` is a small loop with no model in it. Each tick it
// ends or idles on the control markers, collects wake events, decides whether
// a turn is due, picks a runner by meter, runs ONE bounded turn and records it.
// Every safety rail lives here or in a GeneralStaff command, never only in the
// prompt. Clocks, sleeps, the meter reader and the turn runner are injectable
// so tests run in milliseconds.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join, resolve } from "path";
import { isStopFilePresent } from "../safety";
import type { SeatContext } from "./config";
import {
  NO_RUNNER_WAIT_MS,
  TICK_MS,
  missingStateHeadings,
  pinOfContext,
} from "./config";
import { loadSeatContext } from "./context";
import {
  decideTick,
  localStopPresent,
  readGo,
  readRemoteControl,
  writeExit,
  type RemoteState,
} from "./control";
import {
  collectEvents,
  failureReason,
  isFastFailure,
  readCarry,
  readWatermark,
  writeCarry,
  writeWatermark,
  type CarryEntry,
  type PreviousTurn,
} from "./events";
import { acquireLock, type LockDeps, type LockHandle } from "./lock";
import { pickRunner, readMeter, type MeterReading, type RunnerAttempt } from "./meter";
import {
  reapRecordedTurn,
  runTurn,
  type ReapDeps,
  type ReapResult,
  type TurnDeps,
  type TurnInput,
  type TurnResult,
} from "./turn";

export interface DriverOptions {
  /** One tick: run a turn if one is due, then end. */
  once?: boolean;
  abort?: AbortSignal;
  /** Release the lock from a process `exit` hook too (the CLI sets this). */
  exitHook?: boolean;
}

export interface DriverDeps {
  /** Reload the seat's context (default: re-read projects.yaml every tick, quietly). */
  loadContext?: () => Promise<SeatContext>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnTurn?: (input: TurnInput, deps: TurnDeps) => Promise<TurnResult>;
  readMeter?: (argv: string[], opts: { cwd: string }) => Promise<MeterReading>;
  env?: NodeJS.ProcessEnv;
  isFleetStop?: () => Promise<boolean> | boolean;
  readRemote?: (ctx: SeatContext) => Promise<RemoteState> | RemoteState;
  lock?: LockDeps;
  /** Host name and kill grace for reaping a recorded turn (tests). */
  reap?: ReapDeps;
  tickMs?: number;
  noRunnerWaitMs?: number;
  /** Intervals and grace passed through to the turn (tests). */
  turn?: Pick<TurnDeps, "stopCheckMs" | "remoteCheckMs" | "killGraceMs" | "timeoutMs">;
}

export interface DriverResult {
  reason: string;
  /** 0 for an orderly end, 1 when another driver already holds the seat. */
  code: number;
  turns: number;
}

export interface TurnRecord {
  n: number;
  started_at: string;
  ended_at: string;
  runner: string;
  meter_percent: number;
  meter_detail: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  end_reason: string;
  stop_detail: string | null;
  state_restored: boolean;
  state_issue: string | null;
  error: string | null;
  events: string[];
  prompt: string;
  events_file: string;
}

export const driverLogPath = (dir: string) => join(dir, "driver.log");
export const turnsJsonlPath = (dir: string) => join(dir, "turns.jsonl");

export function readTurnRecords(dir: string): TurnRecord[] {
  try {
    return readFileSync(turnsJsonlPath(dir), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as TurnRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is TurnRecord => r !== null && typeof r.n === "number");
  } catch {
    return [];
  }
}

/** The next turn number: past every record in turns.jsonl and every turns/<n>/ directory. */
export function nextTurnNumber(dir: string, records: TurnRecord[] = readTurnRecords(dir)): number {
  let max = records.reduce((m, r) => Math.max(m, r.n), 0);
  try {
    for (const name of readdirSync(join(dir, "turns"))) {
      if (/^\d+$/.test(name)) max = Math.max(max, Number(name));
    }
  } catch {
    /* no turns yet */
  }
  return max + 1;
}

/** What is wrong with the brief or state file that would stop a turn from starting. */
export function stateFileProblem(ctx: SeatContext): string | null {
  if (!existsSync(ctx.briefPath)) {
    return `brief file is missing (${ctx.seat.brief}); run \`generalstaff co-seat init\``;
  }
  if (!existsSync(ctx.statePath)) {
    return `state file is missing (${ctx.seat.state_file}); run \`generalstaff co-seat init\``;
  }
  const missing = missingStateHeadings(readFileSync(ctx.statePath, "utf8"));
  if (missing.length) return `state file lacks the headings: ${missing.join(", ")}`;
  return null;
}

function describeAttempts(attempts: RunnerAttempt[]): string {
  return attempts
    .map((a) =>
      a.skipped
        ? `${a.runner} skipped (${a.skipped})`
        : `${a.runner} ${a.reading?.ok ? `${a.reading.percent}%` : "meter failed"} (${a.reading?.detail ?? ""})`,
    )
    .join("; ");
}

/** Sleep that wakes on abort and keeps the heartbeat fresh through a long wait (the no-runner wait is 10 minutes). */
function defaultSleep(ms: number, abort: AbortSignal | undefined, beat: () => void, beatEveryMs: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (abort?.aborted) return resolvePromise();
    const timer = setTimeout(done, ms);
    const beater = ms > beatEveryMs ? setInterval(beat, beatEveryMs) : undefined;
    function done() {
      clearTimeout(timer);
      clearInterval(beater);
      abort?.removeEventListener("abort", done);
      resolvePromise();
    }
    abort?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run the driver for one seat until it ends, idles out (`once`) or is stopped.
 * Releases the lock and writes EXIT.json on every exit path, including a throw.
 */
export async function runDriver(
  initial: SeatContext,
  opts: DriverOptions = {},
  deps: DriverDeps = {},
): Promise<DriverResult> {
  const dir = initial.dir;
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TICK_MS;
  const noRunnerWaitMs = deps.noRunnerWaitMs ?? NO_RUNNER_WAIT_MS;
  let beat: () => void = () => {};
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms, opts.abort, () => beat(), tickMs));
  const env = deps.env ?? process.env;
  const spawnTurn = deps.spawnTurn ?? runTurn;
  const read = deps.readMeter ?? ((argv, o) => readMeter(argv, o));
  const loadContext = deps.loadContext ?? (() => loadSeatContext(initial.seat.id, { quiet: true }));
  const fleetStop = deps.isFleetStop ?? isStopFilePresent;
  const aborted = () => opts.abort?.aborted === true;

  mkdirSync(dir, { recursive: true });
  const log = (message: string) => {
    appendFileSync(driverLogPath(dir), `${new Date(now()).toISOString()} ${message}\n`);
  };
  let lastKey = "";
  const logChange = (key: string, message: string) => {
    if (key === lastKey) return;
    lastKey = key;
    log(message);
  };

  const acquired = acquireLock(dir, { now, ...deps.lock });
  if (!acquired.ok) {
    log(`driver not started: ${acquired.reason}`);
    return { reason: "lock-held", code: 1, turns: 0 };
  }
  const handle: LockHandle = acquired.handle;
  beat = () => handle.touch();
  const onProcessExit = () => handle.release();
  if (opts.exitHook) process.once("exit", onProcessExit);
  log(
    `driver started: seat=${initial.seat.id} pid=${process.pid}${acquired.tookOver ? " (took over a stale lock)" : ""}${opts.once ? " once" : ""}`,
  );

  let reason = "error";
  let detail: string | undefined;
  let turnsRun = 0;
  /** Why a recorded turn blocks new turns (it is on another host, or would not die). */
  const describeReap = (r: ReapResult): string | null => {
    switch (r.state) {
      case "killed":
        log(`killed an orphaned turn ${r.turn.n} (pid ${r.turn.pid}) left by an earlier driver`);
        return null;
      case "stale":
        log(`removed the record of turn ${r.turn.n} (pid ${r.turn.pid} is gone)`);
        return null;
      case "elsewhere":
        return `a turn recorded on host ${r.turn.host} (turn ${r.turn.n}, pid ${r.turn.pid}) may still be running; check it, then delete ${join(dir, "turn.json")}`;
      case "survived":
        return `the recorded turn ${r.turn.n} (pid ${r.turn.pid}) would not die`;
      default:
        return null;
    }
  };
  try {
    // Holding the lock means no other driver exists: a recorded turn is an orphan.
    describeReap(await reapRecordedTurn(dir, deps.reap));
    let ctx = initial;
    const records = readTurnRecords(dir);
    const lastRecord = records[records.length - 1];
    let n = nextTurnNumber(dir, records) - 1;
    let lastTurnEndMs: number | null = lastRecord ? Date.parse(lastRecord.ended_at) : null;
    if (lastTurnEndMs !== null && Number.isNaN(lastTurnEndMs)) lastTurnEndMs = null;
    let previous: PreviousTurn | null = lastRecord
      ? {
          n: lastRecord.n,
          end_reason: lastRecord.end_reason,
          state_restored: lastRecord.state_restored,
          exit_code: lastRecord.exit_code,
          duration_ms: lastRecord.duration_ms,
        }
      : null;

    for (;;) {
      if (aborted()) {
        reason = "signal";
        break;
      }
      handle.touch();
      if (!handle.verify()) {
        reason = "lock-lost";
        break;
      }

      // Reload the config every tick: the pin must see edits made during a turn.
      let pinNow: string | null = null;
      let configError = "";
      try {
        const fresh = await loadContext();
        if (resolve(fresh.dir) !== resolve(dir)) {
          // The seat directory moved under us: stop/status/watchdog would now look elsewhere.
          reason = "seat-dir-changed";
          detail = `the config now puts this seat in ${fresh.dir}, not ${dir}`;
          break;
        }
        ctx = fresh;
        pinNow = pinOfContext(fresh);
      } catch (error) {
        configError = (error as Error).message;
      }

      const go = readGo(dir);
      let remote: RemoteState | undefined;
      if (ctx.seat.remote_control) {
        remote = await (deps.readRemote
          ? deps.readRemote(ctx)
          : readRemoteControl(ctx.seat.remote_control, ctx.root));
      }
      const decision = decideTick({
        now: now(),
        go,
        localStop: localStopPresent(dir),
        fleetStop: await fleetStop(),
        remote,
        pinNow,
      });

      if (decision.kind === "exit") {
        reason = decision.reason;
        break;
      }
      if (decision.kind === "idle") {
        const extra =
          decision.reason === "config-unreadable"
            ? ` (config unreadable, holding turns: ${configError})`
            : remote && remote.state === "unreadable"
              ? ` (${remote.detail})`
              : "";
        logChange(`idle:${decision.reason}`, `idle: ${decision.reason}${extra}`);
        if (opts.once) {
          reason = "once";
          detail = `idle: ${decision.reason}`;
          break;
        }
        await sleep(tickMs);
        continue;
      }
      if (lastKey.startsWith("idle:")) {
        lastKey = "active";
        log("active: turns enabled");
      }

      // Wake events, with the watermark taken now.
      const sinceLast = lastTurnEndMs === null ? Number.POSITIVE_INFINITY : now() - lastTurnEndMs;
      const heartbeatElapsed = sinceLast >= ctx.seat.wake.heartbeat_seconds * 1000;
      const carriedBefore = readCarry(dir);
      const collected = await collectEvents(ctx, readWatermark(dir), {
        firstTurn: n === 0,
        heartbeat: heartbeatElapsed,
        previous,
        carried: carriedBefore,
      });
      const gapPassed = sinceLast >= ctx.seat.wake.min_gap_seconds * 1000;
      const due = (collected.hasEvents && gapPassed) || heartbeatElapsed;
      if (!due) {
        if (opts.once) {
          reason = "once";
          detail = "no turn due";
          break;
        }
        await sleep(tickMs);
        continue;
      }

      const problem = stateFileProblem(ctx);
      if (problem) {
        logChange("hold:state", `holding turns: ${problem}`);
        if (opts.once) {
          reason = "once";
          detail = `holding: ${problem}`;
          break;
        }
        await sleep(tickMs);
        continue;
      }

      // One turn at a time: never start while a recorded turn may still be alive.
      const orphan = describeReap(await reapRecordedTurn(dir, deps.reap));
      if (orphan) {
        logChange("hold:turn-alive", `holding turns: ${orphan}`);
        if (opts.once) {
          reason = "once";
          detail = `holding: ${orphan}`;
          break;
        }
        await sleep(tickMs);
        continue;
      }

      const pick = await pickRunner(ctx.seat.runners, (argv) => read(argv, { cwd: ctx.root }), env);
      if (!pick.runner) {
        logChange("no-runner", `no runner available: ${describeAttempts(pick.readings)}; checking again in ${Math.round(noRunnerWaitMs / 60000)} min`);
        if (opts.once) {
          reason = "once";
          detail = "no runner available";
          break;
        }
        await sleep(noRunnerWaitMs);
        continue;
      }

      // Events are delivered with this turn: record what was seen at collection time.
      writeWatermark(dir, collected.newWatermark);
      n += 1;
      const startedAt = now();
      log(
        `turn ${n} start: runner=${pick.runner.id} meter=${pick.reading.percent}% events=${collected.counts.cycles + collected.counts.inbox + collected.counts.sentinels}`,
      );
      lastKey = "";
      const seatCtx = ctx;
      const result = await spawnTurn(
        {
          ctx: seatCtx,
          n,
          runner: pick.runner,
          meterPercent: pick.reading.percent,
          eventLines: collected.lines,
        },
        {
          // The turn keeps real time for its own timers; `now` is only the driver's (injectable) clock.
          env,
          ...deps.turn,
          checkStop: () => {
            if (aborted()) return "signal";
            if (!handle.verify()) return "lock-lost";
            if (localStopPresent(dir)) return "stop";
            // The deadline is a stop too: a turn does not outlive it.
            const g = readGo(dir);
            if (g.kind === "ok" && now() >= Date.parse(g.go.deadline)) return "deadline";
            return Promise.resolve(fleetStop()).then((f) => (f ? "fleet-stop" : null));
          },
          checkRemote: async () => {
            if (!seatCtx.seat.remote_control) return null;
            const r = await (deps.readRemote
              ? deps.readRemote(seatCtx)
              : readRemoteControl(seatCtx.seat.remote_control, seatCtx.root));
            if (r.state !== "ok") return null;
            if (r.stop) return "remote-stop";
            if (!r.go) return "remote-no-go";
            return null;
          },
          onPoll: () => handle.touch(),
        },
      );
      turnsRun += 1;
      const endedAt = now();
      const record: TurnRecord = {
        n,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        runner: result.runner,
        meter_percent: result.meterPercent,
        meter_detail: pick.reading.detail,
        exit_code: result.exitCode,
        signal: result.signal,
        duration_ms: result.durationMs,
        end_reason: result.endReason,
        stop_detail: result.stopDetail ?? null,
        state_restored: result.stateRestored,
        state_issue: result.stateIssue ?? null,
        error: result.error ?? null,
        events: collected.lines,
        prompt: result.promptPath,
        events_file: result.eventsPath,
      };
      appendFileSync(turnsJsonlPath(dir), JSON.stringify(record) + "\n");
      log(
        `turn ${n} end: ${result.endReason}${result.stopDetail ? ` (${result.stopDetail})` : ""} exit=${result.exitCode ?? "none"} duration=${Math.round(result.durationMs / 1000)}s${result.stateRestored ? " state_restored" : ""}${result.stateIssue && !result.stateRestored ? ` state_issue: ${result.stateIssue}` : ""}${result.error ? ` error: ${result.error}` : ""}`,
      );
      lastTurnEndMs = endedAt;
      previous = {
        n,
        end_reason: result.endReason,
        state_restored: result.stateRestored,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      };
      // A turn that failed fast acted on nothing: its events go to the next turn.
      if (isFastFailure({ end_reason: result.endReason, exit_code: result.exitCode, duration_ms: result.durationMs })) {
        const why = failureReason({ end_reason: result.endReason, exit_code: result.exitCode, duration_ms: result.durationMs });
        const carry: CarryEntry[] = [
          ...carriedBefore,
          ...collected.eventLines.map((line) => ({ from_turn: n, reason: why, line })),
        ];
        writeCarry(dir, carry.slice(-200));
        log(`turn ${n} failed fast (${why}); ${carry.length} event line(s) carried to the next turn`);
      } else {
        writeCarry(dir, []);
      }

      if (opts.once) {
        reason = "once";
        break;
      }
      await sleep(tickMs);
    }
  } catch (error) {
    reason = "error";
    detail = (error as Error).message;
    throw error;
  } finally {
    try {
      writeExit(dir, { reason, at: new Date(now()).toISOString(), detail });
      log(`driver ended: ${reason}${detail ? ` (${detail})` : ""}`);
    } finally {
      handle.release();
      if (opts.exitHook) process.off("exit", onProcessExit);
    }
  }
  return { reason, code: 0, turns: turnsRun };
}

/** Wire SIGINT and SIGTERM to an AbortController: the driver kills its turn, writes EXIT.json and releases the lock. */
export function installDriverSignalHandlers(controller: AbortController): () => void {
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}
