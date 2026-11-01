import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { pinOfContext, type SeatContext } from "../../src/co_seat/config";
import { readExit, writeGo, writeStop } from "../../src/co_seat/control";
import {
  nextTurnNumber,
  readTurnRecords,
  runDriver,
  stateFileProblem,
  type DriverDeps,
  type TurnRecord,
} from "../../src/co_seat/driver";
import { acquireLock, lockPath } from "../../src/co_seat/lock";
import { readCarry } from "../../src/co_seat/events";
import { liveTurnPath, type LiveTurnRecord } from "../../src/co_seat/turn";
import type { RemoteState } from "../../src/co_seat/control";
import {
  STATE_TEMPLATE,
  loadCtx,
  makeControlRepo,
  makeSandbox,
  meterScript,
  recordingRunnerSource,
  scriptPath,
  seatBlock,
  writeProjectsYaml,
  writeSeatFiles,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
const orphans: number[] = [];
afterEach(() => {
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  sb.cleanup();
});

function spawnOrphan(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  child.unref();
  orphans.push(child.pid!);
  return child.pid!;
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function recordTurn(dir: string, rec: Partial<LiveTurnRecord> & { pid: number }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    liveTurnPath(dir),
    JSON.stringify({ pgid: rec.pid, host: hostname(), started: new Date().toISOString(), n: 1, exe: process.execPath, ...rec }),
  );
}

const T0 = Date.parse("2026-11-01T12:00:00Z");
const DAY = 86_400_000;

interface Fx {
  ctx: SeatContext;
  statePath: string;
  runnerLog: string;
  meterFile: (name?: string) => string;
  setMeter: (value: string, name?: string) => void;
  go: (now?: number, days?: number) => void;
  calls: () => Array<Record<string, any>>;
  clock: { t: number };
  sleeps: number[];
  deps: (extra?: DriverDeps) => DriverDeps;
  logText: () => string;
  addCycleEnd: (id: string) => void;
}

async function fx(
  opts: {
    runner?: Parameters<typeof recordingRunnerSource>[0] extends infer O ? Partial<O> : never;
    wake?: Record<string, unknown>;
    seatExtra?: Record<string, unknown>;
    runners?: Array<{ id: string; max: number; meterName?: string; runnerOpts?: Record<string, unknown>; env?: Record<string, string>; command?: string[] }>;
  } = {},
): Promise<Fx> {
  const runnerLog = join(sb.root, "runner-calls.jsonl");
  const statePath = join(sb.root, "co-seat", "main", "STATE.md");
  const specs = opts.runners ?? [{ id: "primary", max: 85 }];
  const runners = specs.map((spec) => {
    const meterName = spec.meterName ?? spec.id;
    const meterFile = join(sb.root, `meter-${meterName}.txt`);
    writeFileSync(meterFile, "10");
    const script = scriptPath(
      sb.root,
      `runner-${spec.id}.mjs`,
      recordingRunnerSource({ logPath: runnerLog, statePath, ...opts.runner, ...(spec.runnerOpts ?? {}) }),
    );
    return {
      id: spec.id,
      ...(spec.env ? { env: spec.env } : {}),
      command: spec.command ?? [process.execPath, script, "{prompt}"],
      meter: {
        command: meterScript(
          sb.root,
          `meter-${meterName}.mjs`,
          `import { readFileSync } from "fs"; process.stdout.write(readFileSync(${JSON.stringify(meterFile)}, "utf8"));`,
        ),
        max_used_percent: spec.max,
      },
    };
  });
  writeProjectsYaml(sb.root, [seatBlock("main", { runners, wake: opts.wake, extra: opts.seatExtra })]);
  writeSeatFiles(sb.root, "main");
  const ctx = await loadCtx("main");
  const clock = { t: T0 };
  const sleeps: number[] = [];
  const f: Fx = {
    ctx,
    statePath,
    runnerLog,
    clock,
    sleeps,
    meterFile: (name = "primary") => join(sb.root, `meter-${name}.txt`),
    setMeter: (value, name = "primary") => writeFileSync(join(sb.root, `meter-${name}.txt`), value),
    go: (now = T0, days = 7) =>
      writeGo(ctx.dir, {
        version: 1,
        set_at: new Date(now).toISOString(),
        deadline: new Date(now + days * DAY).toISOString(),
        pin: pinOfContext(ctx),
        days,
      }),
    calls: () =>
      existsSync(runnerLog)
        ? readFileSync(runnerLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    deps: (extra = {}) => ({
      now: () => clock.t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock.t += ms;
      },
      turn: { stopCheckMs: 40, remoteCheckMs: 80, killGraceMs: 300 },
      lock: { host: "test-host" },
      ...extra,
    }),
    logText: () => (existsSync(join(ctx.dir, "driver.log")) ? readFileSync(join(ctx.dir, "driver.log"), "utf8") : ""),
    addCycleEnd: (id) => {
      mkdirSync(join(sb.root, "state", "app"), { recursive: true });
      appendFileSync(
        join(sb.root, "state", "app", "PROGRESS.jsonl"),
        JSON.stringify({ timestamp: "2026-11-01T10:00:00.000Z", event: "cycle_end", project_id: "app", cycle_id: id, data: { outcome: "verified" } }) + "\n",
      );
    },
  };
  return f;
}

const lockDir = (f: Fx) => lockPath(f.ctx.dir);

describe("driver --once, end to end", () => {
  it("runs one turn, records it, writes EXIT.json and releases the lock", async () => {
    const f = await fx();
    f.go();
    const result = await runDriver(f.ctx, { once: true }, f.deps());
    expect(result).toEqual({ reason: "once", code: 0, turns: 1 });

    const records = readTurnRecords(f.ctx.dir);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r).toMatchObject({ n: 1, runner: "primary", meter_percent: 10, exit_code: 0, end_reason: "exit", state_restored: false, stop_detail: null });
    expect(r.events[0]).toContain("First turn of this seat");
    expect(readFileSync(r.prompt, "utf8")).toContain('co-seat "main", turn 1');
    expect(existsSync(r.events_file)).toBe(true);
    expect(Date.parse(r.started_at)).toBe(T0);

    expect(readFileSync(f.statePath, "utf8")).toContain("ran turn 1");
    expect(f.calls()).toHaveLength(1);
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "once" });
    expect(existsSync(lockDir(f))).toBe(false);
    expect(existsSync(join(f.ctx.dir, "watermark.json"))).toBe(true);
    expect(existsSync(join(f.ctx.dir, "heartbeat"))).toBe(true);
    const log = f.logText();
    expect(log).toContain("driver started");
    expect(log).toContain("turn 1 start: runner=primary meter=10%");
    expect(log).toContain("turn 1 end: exit exit=0");
    expect(log).toContain("driver ended: once");
  });

  it("does not run a turn that is not due, then runs one when an event arrives after min_gap, then a heartbeat turn", async () => {
    const f = await fx();
    f.go();
    await runDriver(f.ctx, { once: true }, f.deps());
    expect(f.calls()).toHaveLength(1);

    // 10 s later: nothing due, even with an event (min_gap_seconds is 300).
    f.clock.t = T0 + 10_000;
    f.addCycleEnd("c1");
    const early = await runDriver(f.ctx, { once: true }, f.deps());
    expect(early).toMatchObject({ reason: "once", turns: 0 });
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "once", detail: "no turn due" });

    // After the gap, the waiting event wakes a turn that carries it.
    f.clock.t = T0 + 400_000;
    const second = await runDriver(f.ctx, { once: true }, f.deps());
    expect(second.turns).toBe(1);
    const records = readTurnRecords(f.ctx.dir);
    expect(records[1]!.events).toEqual(["cycle ended: app c1 outcome=verified"]);

    // Nothing for a long while: the heartbeat (1800 s) wakes a turn with a heartbeat note.
    f.clock.t = T0 + 400_000 + 100_000;
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(0);
    f.clock.t = T0 + 400_000 + 1_900_000;
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(1);
    const third = readTurnRecords(f.ctx.dir)[2]!;
    expect(third.events.some((e) => e.startsWith("Heartbeat"))).toBe(true);
  });

  it("tells the next turn when the previous one was killed, or its state file was restored", async () => {
    const f = await fx({ runner: { sleepMs: 30_000 } });
    f.go();
    const first = await runDriver(f.ctx, { once: true }, f.deps({ turn: { stopCheckMs: 40, killGraceMs: 300, timeoutMs: 400 } }));
    expect(first.turns).toBe(1);
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "timeout" });

    // Swap in a runner that breaks the state file (the script is not part of the pin).
    const swap = (opts: Parameters<typeof recordingRunnerSource>[0]) =>
      scriptPath(sb.root, "runner-primary.mjs", recordingRunnerSource(opts));
    swap({ logPath: f.runnerLog, statePath: f.statePath, breakState: true });
    f.clock.t = T0 + 2_000_000;
    await runDriver(f.ctx, { once: true }, f.deps());
    const second = readTurnRecords(f.ctx.dir)[1]!;
    expect(second.events.some((e) => e.includes("Turn 1 was killed (timeout)"))).toBe(true);
    expect(second.state_restored).toBe(true);

    swap({ logPath: f.runnerLog, statePath: f.statePath });
    f.clock.t = T0 + 4_000_000;
    await runDriver(f.ctx, { once: true }, f.deps());
    const third = readTurnRecords(f.ctx.dir)[2]!;
    expect(third.events.some((e) => e.includes("Turn 2 left the state file without a required heading"))).toBe(true);
    expect(third.events.some((e) => e.includes("was killed"))).toBe(false);
    expect(readFileSync(f.statePath, "utf8")).toContain("ran turn 3");
  });
});

describe("driver: ends and idles", () => {
  it("ends with no GO", async () => {
    const f = await fx();
    const r = await runDriver(f.ctx, { once: true }, f.deps());
    expect(r).toEqual({ reason: "no-go", code: 0, turns: 0 });
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "no-go" });
    expect(existsSync(lockDir(f))).toBe(false);
    expect(f.calls()).toHaveLength(0);
  });

  it("ends on the seat's own STOP, sticky until go", async () => {
    const f = await fx();
    f.go();
    writeStop(f.ctx.dir, T0);
    const r = await runDriver(f.ctx, {}, f.deps());
    expect(r.reason).toBe("stop");
    expect(f.calls()).toHaveLength(0);
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "stop" });
  });

  it("ends past the deadline", async () => {
    const f = await fx();
    f.go(T0 - 8 * DAY, 7);
    const r = await runDriver(f.ctx, {}, f.deps());
    expect(r.reason).toBe("deadline");
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "deadline" });
    expect(f.calls()).toHaveLength(0);
  });

  it("idles on the fleet STOP (one log line, no turn) and resumes when it clears", async () => {
    const f = await fx();
    f.go();
    writeFileSync(join(sb.root, "STOP"), "STOP\n");
    let n = 0;
    const deps = f.deps({
      sleep: async (ms) => {
        f.sleeps.push(ms);
        f.clock.t += ms;
        n++;
        if (n === 3) rmSync(join(sb.root, "STOP"));
        if (n === 5) writeStop(f.ctx.dir, f.clock.t);
      },
    });
    const r = await runDriver(f.ctx, {}, deps);
    expect(r.reason).toBe("stop");
    const log = f.logText();
    expect(log.match(/idle: fleet-stop/g)).toHaveLength(1);
    expect(log).toContain("active: turns enabled");
    expect(f.calls()).toHaveLength(1); // the first turn ran after the fleet STOP cleared
  });

  it("idles while the config pin has changed, and a brief edit counts", async () => {
    const f = await fx();
    f.go();
    writeFileSync(f.ctx.briefPath, "# brief, edited by a turn\n");
    const r = await runDriver(f.ctx, { once: true }, f.deps());
    expect(r).toMatchObject({ reason: "once", turns: 0 });
    expect(readExit(f.ctx.dir)!.detail).toBe("idle: config-changed");
    expect(f.calls()).toHaveLength(0);
    // Running `go` again (a new pin) lets turns resume.
    f.go();
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(1);
  });

  it("idles when projects.yaml cannot be loaded (fails closed, never grants a turn)", async () => {
    const f = await fx();
    f.go();
    writeFileSync(join(sb.root, "projects.yaml"), "projects: [oops\n");
    const r = await runDriver(f.ctx, { once: true }, f.deps());
    expect(r).toMatchObject({ reason: "once", turns: 0 });
    expect(readExit(f.ctx.dir)!.detail).toBe("idle: config-unreadable");
    expect(f.logText()).toContain("config unreadable, holding turns");
  });

  it("holds turns while the state file is missing a heading", async () => {
    const f = await fx();
    f.go();
    writeFileSync(f.statePath, "# no headings\n");
    expect(stateFileProblem(f.ctx)).toContain("lacks the headings");
    const r = await runDriver(f.ctx, { once: true }, f.deps());
    expect(r.turns).toBe(0);
    expect(readExit(f.ctx.dir)!.detail).toContain("holding:");
    rmSync(f.statePath);
    expect(stateFileProblem(f.ctx)).toContain("state file is missing");
    writeFileSync(f.statePath, STATE_TEMPLATE);
    expect(stateFileProblem(f.ctx)).toBeNull();
  });
});

describe("driver: remote control", () => {
  async function remoteFx() {
    const { repo } = makeControlRepo(sb.root);
    const f = await fx({ seatExtra: { remote_control: { repo, remote: "origin", branch: "main", dir: "co-seat/main" } } });
    f.go();
    return f;
  }
  const remote = (state: RemoteState) => ({ readRemote: () => state });

  it("idles on a remote STOP, a missing remote GO and an unreadable remote, and runs on a remote GO", async () => {
    const f = await remoteFx();
    for (const [state, detail] of [
      [{ state: "ok", go: true, stop: true }, "idle: remote-stop"],
      [{ state: "ok", go: false, stop: false }, "idle: remote-no-go"],
      [{ state: "unreadable", detail: "offline" }, "idle: remote-unreadable"],
    ] as Array<[RemoteState, string]>) {
      const r = await runDriver(f.ctx, { once: true }, f.deps(remote(state)));
      expect(r.turns).toBe(0);
      expect(readExit(f.ctx.dir)!.detail).toBe(detail);
    }
    expect(f.logText()).toContain("offline");
    const ok = await runDriver(f.ctx, { once: true }, f.deps(remote({ state: "ok", go: true, stop: false })));
    expect(ok.turns).toBe(1);
  });

  it("kills a running turn on a remote STOP and idles afterwards", async () => {
    const f = await fx({
      runner: { sleepMs: 30_000 },
      seatExtra: { remote_control: { repo: makeControlRepo(sb.root).repo, remote: "origin", branch: "main", dir: "co-seat/main" } },
    });
    f.go();
    let reads = 0;
    const r = await runDriver(
      f.ctx,
      { once: true },
      f.deps({ readRemote: () => (++reads <= 1 ? { state: "ok", go: true, stop: false } : { state: "ok", go: true, stop: true }) }),
    );
    expect(r.turns).toBe(1);
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "stop", stop_detail: "remote-stop" });
  });
});

describe("driver: runners and meters", () => {
  it("says so once, and waits, when no runner is under its limit; then runs when one is", async () => {
    const f = await fx();
    f.go();
    f.setMeter("99");
    const controller = new AbortController();
    let n = 0;
    const r = await runDriver(
      f.ctx,
      { abort: controller.signal },
      f.deps({
        noRunnerWaitMs: 600_000,
        sleep: async (ms) => {
          f.sleeps.push(ms);
          f.clock.t += ms;
          n++;
          if (n === 3) f.setMeter("5");
          if (n === 5) controller.abort();
        },
      }),
    );
    expect(r.reason).toBe("signal");
    expect(f.sleeps.slice(0, 3)).toEqual([600_000, 600_000, 600_000]);
    expect(f.logText().match(/no runner available/g)).toHaveLength(1);
    expect(f.calls()).toHaveLength(1);
    expect(readTurnRecords(f.ctx.dir)[0]!.meter_percent).toBe(5);
  });

  it("a failing meter reads as 100 and grants no turn", async () => {
    const f = await fx();
    f.go();
    f.setMeter("not a number");
    const r = await runDriver(f.ctx, { once: true }, f.deps());
    expect(r.turns).toBe(0);
    expect(readExit(f.ctx.dir)!.detail).toBe("no runner available");
    expect(f.logText()).toContain("meter failed");
  });

  it("falls back to the second runner and hands back to the first without a restart", async () => {
    const f = await fx({ runners: [{ id: "primary", max: 85 }, { id: "fallback", max: 95 }] });
    f.go();
    f.setMeter("90", "primary");
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(1);
    f.clock.t += 2_000_000;
    f.setMeter("20", "primary");
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(1);
    expect(readTurnRecords(f.ctx.dir).map((r) => r.runner)).toEqual(["fallback", "primary"]);
  });

  it("skips a runner whose env source variable is unset", async () => {
    const f = await fx({
      runners: [
        { id: "primary", max: 85, env: { CHILD_TOKEN: "DRIVER_TEST_UNSET_SOURCE" } },
        { id: "fallback", max: 95 },
      ],
    });
    f.go();
    const env = { ...process.env };
    delete env.DRIVER_TEST_UNSET_SOURCE;
    const r = await runDriver(f.ctx, { once: true }, f.deps({ env }));
    expect(r.turns).toBe(1);
    expect(readTurnRecords(f.ctx.dir)[0]!.runner).toBe("fallback");
    // With the source variable set, the primary runner takes it back.
    f.clock.t += 2_000_000;
    const again = await runDriver(f.ctx, { once: true }, f.deps({ env: { ...env, DRIVER_TEST_UNSET_SOURCE: "tok" } }));
    expect(again.turns).toBe(1);
    expect(readTurnRecords(f.ctx.dir)[1]!.runner).toBe("primary");
    expect(f.calls()[1]!.token).toBe("tok");
  });
});

describe("driver: loop, stop and exit paths", () => {
  it("runs a turn per due event across ticks and ends on STOP, releasing the lock", async () => {
    const f = await fx();
    f.go();
    let n = 0;
    const r = await runDriver(
      f.ctx,
      {},
      f.deps({
        sleep: async (ms) => {
          f.sleeps.push(ms);
          f.clock.t += ms;
          n++;
          if (n === 2) f.addCycleEnd("c1"); // inside min_gap: waits
          if (n === 3) f.clock.t += 400_000; // gap passes
          if (n === 6) writeStop(f.ctx.dir, f.clock.t);
        },
      }),
    );
    expect(r.reason).toBe("stop");
    const records = readTurnRecords(f.ctx.dir);
    expect(records.map((x) => x.n)).toEqual([1, 2]);
    expect(records[1]!.events).toEqual(["cycle ended: app c1 outcome=verified"]);
    expect(f.sleeps.every((ms) => ms === 60_000)).toBe(true);
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "stop" });
    expect(existsSync(lockDir(f))).toBe(false);
  });

  it("a STOP kills a running turn within the in-flight check, then ends", async () => {
    const f = await fx({ runner: { sleepMs: 30_000 } });
    f.go();
    const done = runDriver(f.ctx, {}, { ...f.deps(), sleep: async () => {} });
    const started = Date.now();
    while (f.calls().length === 0 && Date.now() - started < 10_000) await new Promise((res) => setTimeout(res, 20));
    expect(f.calls()).toHaveLength(1);
    writeStop(f.ctx.dir);
    const r = await done;
    expect(r.reason).toBe("stop");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "stop", stop_detail: "stop" });
    expect(() => process.kill(f.calls()[0]!.pid, 0)).toThrow();
    expect(existsSync(lockDir(f))).toBe(false);
  });

  it("the fleet STOP kills a running turn and then idles the seat", async () => {
    const f = await fx({ runner: { sleepMs: 30_000 } });
    f.go();
    const controller = new AbortController();
    const done = runDriver(f.ctx, { abort: controller.signal }, { ...f.deps(), sleep: async () => { await new Promise((res) => setTimeout(res, 20)); } });
    const started = Date.now();
    while (f.calls().length === 0 && Date.now() - started < 10_000) await new Promise((res) => setTimeout(res, 20));
    writeFileSync(join(sb.root, "STOP"), "STOP\n");
    // Wait for the idle line, then end the driver.
    while (!f.logText().includes("idle: fleet-stop") && Date.now() - started < 15_000) await new Promise((res) => setTimeout(res, 20));
    controller.abort();
    const r = await done;
    expect(r.reason).toBe("signal");
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "stop", stop_detail: "fleet-stop" });
  });

  it("an abort (SIGINT or SIGTERM) mid-turn kills the turn, writes EXIT.json and releases the lock", async () => {
    const f = await fx({ runner: { sleepMs: 30_000 } });
    f.go();
    const controller = new AbortController();
    const done = runDriver(f.ctx, { abort: controller.signal }, f.deps());
    const started = Date.now();
    while (f.calls().length === 0 && Date.now() - started < 10_000) await new Promise((res) => setTimeout(res, 20));
    controller.abort();
    const r = await done;
    expect(r.reason).toBe("signal");
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "stop", stop_detail: "signal" });
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "signal" });
    expect(existsSync(lockDir(f))).toBe(false);
  });

  it("a thrown error still writes EXIT.json and releases the lock, and rethrows", async () => {
    const f = await fx();
    f.go();
    await expect(
      runDriver(f.ctx, { once: true }, f.deps({ spawnTurn: async () => { throw new Error("boom"); } })),
    ).rejects.toThrow("boom");
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "error", detail: "boom" });
    expect(existsSync(lockDir(f))).toBe(false);
    expect(f.logText()).toContain("driver ended: error (boom)");
  });

  it("refuses to start when another driver holds the seat, and leaves that driver's lock alone", async () => {
    const f = await fx();
    f.go();
    const held = acquireLock(f.ctx.dir, { host: "test-host" });
    expect(held.ok).toBe(true);
    const r = await runDriver(f.ctx, { once: true }, f.deps());
    expect(r).toEqual({ reason: "lock-held", code: 1, turns: 0 });
    expect(existsSync(lockDir(f))).toBe(true);
    expect(readExit(f.ctx.dir)).toBeNull();
    expect(f.logText()).toContain("driver not started");
    if (held.ok) held.handle.release();
  });

  it("stands down when its lock is taken from under it", async () => {
    const f = await fx();
    f.go();
    const r = await runDriver(
      f.ctx,
      {},
      f.deps({
        spawnTurn: async (input, deps) => {
          rmSync(lockDir(f), { recursive: true });
          const taken = acquireLock(f.ctx.dir, { host: "test-host" });
          expect(taken.ok).toBe(true);
          return {
            n: input.n, runner: input.runner.id, meterPercent: 1, exitCode: 0, signal: null, durationMs: 1,
            endReason: "exit", stateRestored: false, promptPath: "p", eventsPath: "e",
          };
        },
      }),
    );
    expect(r.reason).toBe("lock-lost");
    // The other driver's lock is intact.
    expect(existsSync(lockDir(f))).toBe(true);
  });
});

describe("turn bookkeeping helpers", () => {
  it("nextTurnNumber looks past turns.jsonl and the turns/ directories", () => {
    const dir = join(sb.root, "seat");
    expect(nextTurnNumber(dir)).toBe(1);
    mkdirSync(join(dir, "turns", "7"), { recursive: true });
    expect(nextTurnNumber(dir)).toBe(8);
    writeFileSync(join(dir, "turns.jsonl"), JSON.stringify({ n: 9 } as Partial<TurnRecord>) + "\nnot json\n");
    expect(readTurnRecords(dir)).toHaveLength(1);
    expect(nextTurnNumber(dir)).toBe(10);
  });
});

describe("driver: failed turns keep their events", () => {
  it("a turn that exits non-zero within a minute hands its events to the next turn, labelled, and the next turn notes the failure", async () => {
    const f = await fx({ runner: { exit: 3 } });
    f.go();
    await runDriver(f.ctx, { once: true }, f.deps()); // turn 1 fails fast; its first-turn note is not an event
    const swap = (opts: Parameters<typeof recordingRunnerSource>[0]) =>
      scriptPath(sb.root, "runner-primary.mjs", recordingRunnerSource(opts));
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ exit_code: 3, end_reason: "exit" });

    f.clock.t = T0 + 400_000;
    f.addCycleEnd("c1");
    await runDriver(f.ctx, { once: true }, f.deps()); // turn 2 gets c1 and fails fast too
    const carry = readCarry(f.ctx.dir);
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatchObject({ from_turn: 2, line: "cycle ended: app c1 outcome=verified" });
    expect(carry[0]!.reason).toMatch(/^exit code 3 after \d+ s$/);
    expect(f.logText()).toContain("turn 2 failed fast");

    // The runner is fixed; the carried event reaches turn 3 even though nothing new happened.
    swap({ logPath: f.runnerLog, statePath: f.statePath });
    f.clock.t = T0 + 800_000;
    await runDriver(f.ctx, { once: true }, f.deps());
    const third = readTurnRecords(f.ctx.dir)[2]!;
    expect(third.events.some((e) => e.startsWith("CARRIED FROM TURN 2 (it failed: exit code 3 after") && e.endsWith("cycle ended: app c1 outcome=verified"))).toBe(true);
    expect(third.events.some((e) => e.includes("Turn 2 failed fast (exit code 3"))).toBe(true);
    // Turn 3 succeeded, so nothing is carried any more.
    expect(readCarry(f.ctx.dir)).toEqual([]);
    f.clock.t = T0 + 1_600_000;
    await runDriver(f.ctx, { once: true }, f.deps());
    expect(readTurnRecords(f.ctx.dir)[3]?.events.some((e) => e.startsWith("CARRIED"))).not.toBe(true);
  });

  it("carried events accumulate across consecutive failures, each keeping the turn that first failed on it", async () => {
    const f = await fx({ runner: { exit: 1 } });
    f.go();
    await runDriver(f.ctx, { once: true }, f.deps());
    f.clock.t = T0 + 400_000;
    f.addCycleEnd("c1");
    await runDriver(f.ctx, { once: true }, f.deps());
    f.clock.t = T0 + 800_000;
    f.addCycleEnd("c2");
    await runDriver(f.ctx, { once: true }, f.deps());
    const carry = readCarry(f.ctx.dir);
    expect(carry.map((c) => [c.from_turn, c.line])).toEqual([
      [2, "cycle ended: app c1 outcome=verified"],
      [3, "cycle ended: app c2 outcome=verified"],
    ]);
    const third = readTurnRecords(f.ctx.dir)[2]!;
    expect(third.events.filter((e) => e.startsWith("CARRIED FROM TURN 2"))).toHaveLength(1);
  });

  it("a runner that cannot start (spawn_error) carries its events too", async () => {
    const f = await fx({ runners: [{ id: "primary", max: 85, command: ["definitely-not-a-real-binary-xyz", "{prompt}"] }] });
    f.go();
    await runDriver(f.ctx, { once: true }, f.deps());
    f.clock.t = T0 + 400_000;
    f.addCycleEnd("c1");
    await runDriver(f.ctx, { once: true }, f.deps());
    expect(readTurnRecords(f.ctx.dir)[1]).toMatchObject({ end_reason: "spawn_error" });
    expect(readCarry(f.ctx.dir)[0]).toMatchObject({ from_turn: 2, reason: "it could not start", line: "cycle ended: app c1 outcome=verified" });
    f.clock.t = T0 + 800_000;
    await runDriver(f.ctx, { once: true }, f.deps());
    const third = readTurnRecords(f.ctx.dir)[2]!;
    expect(third.events.some((e) => e.startsWith("CARRIED FROM TURN 2 (it failed: it could not start)"))).toBe(true);
    expect(third.events.some((e) => e.includes("Turn 2 failed fast (it could not start)"))).toBe(true);
  });

  it("a slow failure, a timeout and a stop do not carry (the turn had its chance)", async () => {
    const f = await fx({ runner: { sleepMs: 30_000 } });
    f.go();
    await runDriver(f.ctx, { once: true }, f.deps({ turn: { stopCheckMs: 40, killGraceMs: 300, timeoutMs: 400 } }));
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "timeout" });
    expect(readCarry(f.ctx.dir)).toEqual([]);
  });
});

describe("driver: a dead driver's turn is not left running", () => {
  it("kills a recorded same-host turn that is still alive when the driver starts, then carries on", async () => {
    const f = await fx();
    f.go();
    const pid = spawnOrphan();
    recordTurn(f.ctx.dir, { pid });
    const r = await runDriver(f.ctx, { once: true }, f.deps({ reap: { graceMs: 400 } }));
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(false);
    expect(f.logText()).toContain(`killed an orphaned turn 1 (pid ${pid})`);
    expect(r.turns).toBe(1);
  });

  it("holds turns while a recorded turn on another host may still be running, and leaves its record", async () => {
    const f = await fx();
    f.go();
    const pid = spawnOrphan();
    recordTurn(f.ctx.dir, { pid, host: "some-other-host" });
    const r = await runDriver(f.ctx, { once: true }, f.deps({ reap: { graceMs: 200 } }));
    expect(r.turns).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect(existsSync(liveTurnPath(f.ctx.dir))).toBe(true);
    expect(readExit(f.ctx.dir)!.detail).toContain("holding: a turn recorded on host some-other-host");
    expect(f.logText()).toContain("holding turns: a turn recorded on host some-other-host");
    expect(f.calls()).toHaveLength(0);
  });

  it("removes the record of a turn that is gone, and does not kill a process that only reused its pid (POSIX)", async () => {
    const f = await fx();
    f.go();
    recordTurn(f.ctx.dir, { pid: 99_999_999 });
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(1);
    expect(f.logText()).toContain("removed the record of turn 1");
    if (process.platform === "win32") return;
    // The recorded pid is now a live process that is not the recorded executable: it must survive.
    f.clock.t += 2_000_000;
    recordTurn(f.ctx.dir, { pid: process.pid, exe: "/no/such/runner-binary" });
    expect((await runDriver(f.ctx, { once: true }, f.deps())).turns).toBe(1);
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("driver: deadline and seat directory", () => {
  it("kills a running turn at the deadline and ends with reason deadline", async () => {
    const f = await fx({ runner: { sleepMs: 30_000 } });
    const soon = Date.now() + 900;
    writeGo(f.ctx.dir, {
      version: 1,
      set_at: new Date().toISOString(),
      deadline: new Date(soon).toISOString(),
      pin: pinOfContext(f.ctx),
      days: 1,
    });
    const started = Date.now();
    const r = await runDriver(f.ctx, {}, f.deps({ now: Date.now, sleep: async () => {} }));
    expect(r.reason).toBe("deadline");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "stop", stop_detail: "deadline" });
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "deadline" });
    expect(() => process.kill(f.calls()[0]!.pid, 0)).toThrow();
  });

  it("extend during a turn moves the deadline the in-flight check uses", async () => {
    const f = await fx({ runner: { sleepMs: 1500 } });
    const soon = Date.now() + 600;
    const go = (deadlineMs: number) =>
      writeGo(f.ctx.dir, { version: 1, set_at: new Date().toISOString(), deadline: new Date(deadlineMs).toISOString(), pin: pinOfContext(f.ctx), days: 1 });
    go(soon);
    // A person extends 100 ms in; the turn must run to the end.
    setTimeout(() => go(Date.now() + 86_400_000), 100);
    const r = await runDriver(f.ctx, { once: true }, f.deps({ now: Date.now }));
    expect(r.turns).toBe(1);
    expect(readTurnRecords(f.ctx.dir)[0]).toMatchObject({ end_reason: "exit", exit_code: 0 });
  });

  it("exits, writing EXIT.json, when the config puts the seat in a different state directory", async () => {
    const f = await fx();
    f.go();
    const elsewhere = join(sb.root, "elsewhere", "_co-seat", "main");
    const r = await runDriver(f.ctx, { once: true }, f.deps({ loadContext: async () => ({ ...f.ctx, dir: elsewhere }) }));
    expect(r).toMatchObject({ reason: "seat-dir-changed", turns: 0 });
    expect(readExit(f.ctx.dir)).toMatchObject({ reason: "seat-dir-changed" });
    expect(readExit(f.ctx.dir)!.detail).toContain(elsewhere);
    expect(f.calls()).toHaveLength(0);
    expect(existsSync(lockDir(f))).toBe(false);
  });
});
