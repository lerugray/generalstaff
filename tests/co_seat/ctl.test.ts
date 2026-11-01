import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import {
  extendSeat,
  formatStatus,
  goSeat,
  initSeat,
  seatStatus,
  startDetached,
  stopSeat,
  watchdogSeat,
} from "../../src/co_seat/ctl";
import { pinOfContext } from "../../src/co_seat/config";
import { readGo, goPath, localStopPresent, readRemoteControl, setRemoteMarkers, stopPath, writeExit, writeStop } from "../../src/co_seat/control";
import { readTurnRecords } from "../../src/co_seat/driver";
import { acquireLock, heartbeatPath, lockPath } from "../../src/co_seat/lock";
import { parkItem } from "../../src/co_seat/park";
import { liveTurnPath } from "../../src/co_seat/turn";
import {
  STATE_TEMPLATE,
  loadCtx,
  makeControlRepo,
  makeSandbox,
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

const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 86_400_000;
const inTurn = { GS_CO_SEAT: "1" } as NodeJS.ProcessEnv;

async function ready(seatExtra: Record<string, unknown> = {}, authority: Record<string, unknown> = {}) {
  writeProjectsYaml(sb.root, [seatBlock("main", { extra: seatExtra, authority })]);
  writeSeatFiles(sb.root, "main");
  return loadCtx("main");
}

describe("init", () => {
  function templates(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "BRIEF.md"), "# brief template\n");
    writeFileSync(join(dir, "STATE.md"), STATE_TEMPLATE);
    writeFileSync(join(dir, "claude-settings.json"), "{}\n");
    return dir;
  }

  it("writes the brief, state and settings templates to the configured paths and never overwrites", async () => {
    writeProjectsYaml(sb.root, [seatBlock("main")]);
    const ctx = await loadCtx("main");
    const examplesDir = templates(join(sb.root, "tpl"));
    const first = initSeat(ctx, { examplesDir });
    expect(first.written).toEqual([
      ctx.briefPath,
      ctx.statePath,
      join(sb.root, "co-seat", "main", "claude-settings.json"),
    ]);
    expect(readFileSync(ctx.briefPath, "utf8")).toBe("# brief template\n");
    writeFileSync(ctx.briefPath, "# my brief\n");
    const second = initSeat(ctx, { examplesDir });
    expect(second.written).toEqual([]);
    expect(second.kept).toHaveLength(3);
    expect(readFileSync(ctx.briefPath, "utf8")).toBe("# my brief\n");
  });

  it("refuses, writing nothing, when a template is missing", async () => {
    writeProjectsYaml(sb.root, [seatBlock("main")]);
    const ctx = await loadCtx("main");
    const dir = join(sb.root, "tpl");
    mkdirSync(dir);
    writeFileSync(join(dir, "BRIEF.md"), "x");
    expect(() => initSeat(ctx, { examplesDir: dir })).toThrow(/template is missing/);
    expect(existsSync(ctx.briefPath)).toBe(false);
  });

  it("the shipped templates in examples/co-seat/ are what init copies by default", async () => {
    const shipped = join(import.meta.dir, "..", "..", "examples", "co-seat");
    if (!existsSync(join(shipped, "BRIEF.md"))) return; // written by the docs change
    writeProjectsYaml(sb.root, [seatBlock("main")]);
    const ctx = await loadCtx("main");
    const r = initSeat(ctx);
    expect(r.written).toHaveLength(3);
    expect(readFileSync(ctx.briefPath, "utf8")).toBe(readFileSync(join(shipped, "BRIEF.md"), "utf8"));
  });
});

describe("go", () => {
  it("writes GO with the pin and a deadline run_days out, clears STOP, then does a watchdog pass", async () => {
    const ctx = await ready();
    writeStop(ctx.dir, NOW);
    const spawned: number[] = [];
    const r = goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => (spawned.push(1), 4242) });
    expect(r.go.deadline).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(r.go.days).toBe(7);
    expect(r.go.pin).toBe(pinOfContext(ctx));
    expect(localStopPresent(ctx.dir)).toBe(false);
    expect(readGo(ctx.dir)).toMatchObject({ kind: "ok", go: { pin: r.go.pin } });
    expect(r.watchdog).toMatchObject({ action: "started", pid: 4242 });
    expect(spawned).toHaveLength(1);
  });

  it("takes --days, up to 30, and refuses anything else without changing anything", async () => {
    const ctx = await ready();
    const deps = { now: () => NOW, spawnDriver: () => 1 };
    expect(goSeat(ctx, { days: 30 }, deps).go.deadline).toBe(new Date(NOW + 30 * DAY).toISOString());
    for (const bad of [0, 31, 1.5, -2]) {
      writeStop(ctx.dir, NOW);
      expect(() => goSeat(ctx, { days: bad }, deps)).toThrow(/--days/);
      expect(localStopPresent(ctx.dir)).toBe(true);
    }
  });

  it("refuses without the brief or state file, pointing at init", async () => {
    writeProjectsYaml(sb.root, [seatBlock("main")]);
    const ctx = await loadCtx("main");
    expect(() => goSeat(ctx, {}, { spawnDriver: () => 1 })).toThrow(/brief file is missing.*co-seat init/);
    mkdirSync(join(sb.root, "co-seat", "main"), { recursive: true });
    writeFileSync(ctx.briefPath, "# b\n");
    expect(() => goSeat(ctx, {}, { spawnDriver: () => 1 })).toThrow(/state file is missing/);
    expect(existsSync(goPath(ctx.dir))).toBe(false);
  });

  it("refuses inside a co-seat turn", async () => {
    const ctx = await ready();
    expect(() => goSeat(ctx, {}, { env: inTurn, spawnDriver: () => 1 })).toThrow(/not allowed inside a co-seat turn/);
    expect(existsSync(goPath(ctx.dir))).toBe(false);
  });

  it("--remote needs remote_control; with it, commits GO and clears the remote STOP", async () => {
    const ctx0 = await ready();
    expect(() => goSeat(ctx0, { remote: true }, { spawnDriver: () => 1 })).toThrow(/--remote needs remote_control/);

    const { repo } = makeControlRepo(sb.root);
    const rc = { repo, remote: "origin", branch: "main", dir: "co-seat/main" };
    const ctx = await ready({ remote_control: rc });
    setRemoteMarkers(rc, sb.root, { stop: true }, "stop");
    const r = goSeat(ctx, { remote: true }, { now: () => NOW, spawnDriver: () => 1 });
    expect(r.remoteSet).toBe(true);
    expect(await readRemoteControl(rc, sb.root)).toEqual({ state: "ok", go: true, stop: false });
    expect(r.hint).toBeUndefined();
    // Without --remote, a configured remote_control gets a hint instead.
    const hinted = goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => 1 });
    expect(hinted.hint).toContain("remote GO marker");
  });

  it("a failing remote leaves the local markers untouched", async () => {
    const { repo } = makeControlRepo(sb.root);
    const rc = { repo, remote: "origin", branch: "no-such-branch", dir: "co-seat/main" };
    const ctx = await ready({ remote_control: rc });
    expect(() => goSeat(ctx, { remote: true }, { spawnDriver: () => 1 })).toThrow(/remote control/);
    expect(existsSync(goPath(ctx.dir))).toBe(false);
  });
});

describe("extend", () => {
  it("moves the deadline and nothing else", async () => {
    const ctx = await ready();
    const first = goSeat(ctx, { days: 2 }, { now: () => NOW, spawnDriver: () => 1 }).go;
    const next = extendSeat(ctx, { days: 10 }, { now: () => NOW + DAY });
    expect(next.deadline).toBe(new Date(NOW + 11 * DAY).toISOString());
    expect(next.pin).toBe(first.pin);
    expect(next.set_at).toBe(first.set_at);
    expect(next.days).toBe(first.days);
    expect(next.extended_at).toBe(new Date(NOW + DAY).toISOString());
    expect(localStopPresent(ctx.dir)).toBe(false);
  });

  it("is at most 30 days, and needs a GO to extend", async () => {
    const ctx = await ready();
    expect(() => extendSeat(ctx, { days: 5 })).toThrow(/no GO marker to extend/);
    goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => 1 });
    expect(() => extendSeat(ctx, { days: 31 }, { now: () => NOW })).toThrow(/at most 30/);
    expect(extendSeat(ctx, { days: 30 }, { now: () => NOW }).deadline).toBe(new Date(NOW + 30 * DAY).toISOString());
  });

  it("refuses inside a co-seat turn, so a turn cannot extend its own life", async () => {
    const ctx = await ready();
    goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => 1 });
    const before = readFileSync(goPath(ctx.dir), "utf8");
    expect(() => extendSeat(ctx, { days: 30 }, { env: inTurn })).toThrow(/not allowed inside a co-seat turn/);
    expect(readFileSync(goPath(ctx.dir), "utf8")).toBe(before);
  });
});

describe("stop", () => {
  it("writes STOP and removes GO; go restores", async () => {
    const ctx = await ready();
    goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => 1 });
    await stopSeat(ctx, {}, { now: () => NOW });
    expect(localStopPresent(ctx.dir)).toBe(true);
    expect(readGo(ctx.dir)).toEqual({ kind: "missing" });
    goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => 1 });
    expect(localStopPresent(ctx.dir)).toBe(false);
    expect(readGo(ctx.dir).kind).toBe("ok");
  });

  it("is allowed inside a co-seat turn", async () => {
    const ctx = await ready();
    goSeat(ctx, {}, { now: () => NOW, spawnDriver: () => 1 });
    const prev = process.env.GS_CO_SEAT;
    process.env.GS_CO_SEAT = "1";
    try {
      await stopSeat(ctx, {}, { env: inTurn });
    } finally {
      if (prev === undefined) delete process.env.GS_CO_SEAT;
      else process.env.GS_CO_SEAT = prev;
    }
    expect(localStopPresent(ctx.dir)).toBe(true);
  });

  it("--remote commits the remote STOP marker; without remote_control the local stop still lands, then it complains", async () => {
    const plain = await ready();
    goSeat(plain, {}, { now: () => NOW, spawnDriver: () => 1 });
    await expect(stopSeat(plain, { remote: true })).rejects.toThrow(/local STOP written and GO removed, but --remote needs remote_control/);
    expect(localStopPresent(plain.dir)).toBe(true);

    const { repo } = makeControlRepo(sb.root);
    const rc = { repo, remote: "origin", branch: "main", dir: "co-seat/main" };
    const ctx = await ready({ remote_control: rc });
    const r = await stopSeat(ctx, { remote: true });
    expect(r.remoteSet).toBe(true);
    expect(await readRemoteControl(rc, sb.root)).toMatchObject({ state: "ok", stop: true });
  });
});

describe("stop and a running turn", () => {
  function recordedOrphan(dir: string): number {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: process.platform !== "win32", stdio: "ignore" });
    child.unref();
    orphans.push(child.pid!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      liveTurnPath(dir),
      JSON.stringify({ pid: child.pid, pgid: child.pid, host: hostname(), started: new Date().toISOString(), n: 4, exe: process.execPath }),
    );
    return child.pid!;
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("co-seat stop kills a recorded same-host turn tree that is still alive", async () => {
    const ctx = await ready();
    const pid = recordedOrphan(ctx.dir);
    const r = await stopSeat(ctx, {}, { reap: { graceMs: 400 } });
    expect(r.reaped).toMatchObject({ state: "killed", turn: { pid, n: 4 } });
    expect(alive(pid)).toBe(false);
    expect(existsSync(liveTurnPath(ctx.dir))).toBe(false);
    expect(localStopPresent(ctx.dir)).toBe(true);
  });

  it("a stop from inside the turn leaves killing the turn to the driver (a turn must not kill itself first)", async () => {
    const ctx = await ready();
    const pid = recordedOrphan(ctx.dir);
    const r = await stopSeat(ctx, {}, { env: inTurn, reap: { graceMs: 200 } });
    expect(r.reaped).toBeUndefined();
    expect(alive(pid)).toBe(true);
    expect(localStopPresent(ctx.dir)).toBe(true);
  });
});

describe("watchdog", () => {
  const spawnCounter = () => {
    const calls: number[] = [];
    return { calls, spawnDriver: () => (calls.push(1), 111) };
  };

  it("does nothing without GO, with STOP, or past the deadline", async () => {
    const ctx = await ready();
    const s = spawnCounter();
    expect(watchdogSeat(ctx, { now: () => NOW, ...s })).toMatchObject({ action: "skipped", reason: "no GO marker" });
    goSeat(ctx, { days: 1 }, { now: () => NOW, spawnDriver: () => 1 });
    writeStop(ctx.dir, NOW);
    expect(watchdogSeat(ctx, { now: () => NOW, ...s })).toMatchObject({ action: "skipped", reason: "STOP is present" });
    rmSync(stopPath(ctx.dir));
    expect(watchdogSeat(ctx, { now: () => NOW + 2 * DAY, ...s })).toMatchObject({ action: "skipped", reason: "past the deadline" });
    writeFileSync(goPath(ctx.dir), "{garbage");
    expect(watchdogSeat(ctx, { now: () => NOW, ...s }).action).toBe("skipped");
    expect(s.calls).toHaveLength(0);
  });

  it("starts the driver when none is live, and is idempotent once one is", async () => {
    const ctx = await ready();
    goSeat(ctx, { days: 1 }, { now: () => NOW, spawnDriver: () => 1 });
    const deps = {
      now: () => NOW,
      lock: { now: () => Date.now(), host: "h" },
      // The stub plays the driver: it takes the lock for real.
      spawnDriver: () => {
        const got = acquireLock(ctx.dir, { host: "h" });
        expect(got.ok).toBe(true);
        return 777;
      },
    };
    const first = watchdogSeat(ctx, deps);
    expect(first).toMatchObject({ action: "started", pid: 777 });
    const second = watchdogSeat(ctx, deps);
    expect(second.action).toBe("running");
    expect(second.pid).toBe(process.pid);
  });

  it("replaces a stale driver (dead pid)", async () => {
    const ctx = await ready();
    goSeat(ctx, { days: 1 }, { now: () => NOW, spawnDriver: () => 1 });
    const live = acquireLock(ctx.dir, { host: "h", pid: 99999999 });
    expect(live.ok).toBe(true);
    const s = spawnCounter();
    const r = watchdogSeat(ctx, { now: () => Date.now(), lock: { host: "h", isPidAlive: () => false }, ...s });
    expect(r.action).toBe("started");
    expect(r.reason).toContain("stale lock");
    expect(s.calls).toHaveLength(1);
  });
});

describe("startDetached", () => {
  it("starts a real detached driver whose output goes to driver.log, and it ends and releases the lock", async () => {
    const log = join(sb.root, "runner-calls.jsonl");
    const statePath = join(sb.root, "co-seat", "main", "STATE.md");
    const script = scriptPath(sb.root, "runner.mjs", recordingRunnerSource({ logPath: log, statePath }));
    writeProjectsYaml(sb.root, [
      seatBlock("main", {
        runners: [
          {
            id: "primary",
            command: [process.execPath, script, "{prompt}"],
            meter: { command: [process.execPath, scriptPath(sb.root, "meter.mjs", 'console.log("10")')], max_used_percent: 85 },
          },
        ],
      }),
    ]);
    writeSeatFiles(sb.root, "main");
    const ctx = await loadCtx("main");
    goSeat(ctx, {}, { spawnDriver: () => 1 }); // writes GO with the real clock; no real spawn
    const pid = startDetached(ctx, ["--once"]);
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(ctx.dir, "EXIT.json")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(ctx.dir, "EXIT.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(ctx.dir, "EXIT.json"), "utf8"))).toMatchObject({ reason: "once" });
    expect(readTurnRecords(ctx.dir)).toHaveLength(1);
    expect(readFileSync(statePath, "utf8")).toContain("ran turn 1");
    expect(readFileSync(join(ctx.dir, "driver.log"), "utf8")).toContain("driver started");
    expect(existsSync(lockPath(ctx.dir))).toBe(false);
    // The turn ran under the guards' environment, not the detaching process's.
    expect(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!)).toMatchObject({ seat: "1", id: "main", turn: "1" });
  }, 30_000);
});

describe("status", () => {
  it("reports a seat that never ran, then one that is live, pinned, stopped and exited", async () => {
    const ctx = await ready({}, { park_per_day: 3 });
    const fresh = await seatStatus(ctx, { now: () => NOW });
    expect(fresh).toMatchObject({
      seat: "main",
      live: false,
      turns: 0,
      last_turn: null,
      deadline: null,
      markers: { go: "missing", stop: false, fleet_stop: false },
      pin: { recorded: null, matches: null },
      parked_today: { used: 0, cap: 3 },
      aide_messages_today: { used: 0, cap: 0 },
      last_exit: null,
    });
    expect(formatStatus(fresh)).toContain("Co-seat main: not running");
    expect(formatStatus(fresh)).toContain("Deadline: none (no GO marker)");

    goSeat(ctx, { days: 2 }, { now: () => NOW, spawnDriver: () => 1 });
    parkItem(ctx, "app", "Decide something", undefined, NOW);
    const lock = acquireLock(ctx.dir, { host: "h" });
    expect(lock.ok).toBe(true);
    const live = await seatStatus(ctx, { now: () => Date.now(), lock: { host: "h" } });
    expect(live).toMatchObject({ live: true, markers: { go: "ok" }, pin: { matches: true } });
    expect(live.lock.pid).toBe(process.pid);
    expect(live.heartbeat_age_seconds).toBeLessThan(5);
    expect(live.parked_today).toEqual({ used: 1, cap: 3 });
    const text = formatStatus(live);
    expect(text).toContain(`LIVE (pid ${process.pid}`);
    expect(text).toContain("Config pin: matches");
    expect(text).toContain("Parked today: 1 of 3");

    // An edited brief breaks the pin.
    writeFileSync(ctx.briefPath, "# edited\n");
    const changed = await seatStatus(ctx, { now: () => NOW });
    expect(changed.pin.matches).toBe(false);
    expect(formatStatus(changed)).toContain("CHANGED");

    await stopSeat(ctx, {}, { now: () => NOW });
    writeExit(ctx.dir, { reason: "stop", at: new Date(NOW).toISOString() });
    const stopped = await seatStatus(ctx, { now: () => NOW });
    expect(stopped.markers).toMatchObject({ go: "missing", stop: true });
    expect(stopped.last_exit).toMatchObject({ reason: "stop" });
    if (lock.ok) lock.handle.release();
  });

  it("warns when under 24 hours remain, and shows a stale lock", async () => {
    const ctx = await ready();
    goSeat(ctx, { days: 1 }, { now: () => NOW, spawnDriver: () => 1 });
    const soon = await seatStatus(ctx, { now: () => NOW + 20 * 3_600_000 });
    expect(soon.deadline_warning).toBe(true);
    expect(soon.hours_left).toBe(4);
    expect(formatStatus(soon)).toContain("WARNING: under 24 h");
    const early = await seatStatus(ctx, { now: () => NOW });
    expect(early.deadline_warning).toBe(false);

    const held = acquireLock(ctx.dir, { host: "h", pid: 99999999 });
    expect(held.ok).toBe(true);
    for (const p of [heartbeatPath(ctx.dir), join(lockPath(ctx.dir), "owner.json"), lockPath(ctx.dir)]) {
      const t = new Date(Date.now() - 600_000);
      utimesSync(p, t, t);
    }
    const stale = await seatStatus(ctx, { now: () => Date.now(), lock: { host: "h", isPidAlive: () => false } });
    expect(stale.live).toBe(false);
    expect(formatStatus(stale)).toContain("stale lock");
  });

  it("reads the remote markers when remote_control is configured", async () => {
    const { repo } = makeControlRepo(sb.root);
    const rc = { repo, remote: "origin", branch: "main", dir: "co-seat/main" };
    const ctx = await ready({ remote_control: rc });
    setRemoteMarkers(rc, sb.root, { go: true }, "go");
    const s = await seatStatus(ctx, { now: () => NOW });
    expect(s.markers.remote).toEqual({ state: "ok", go: true, stop: false });
    expect(formatStatus(s)).toContain("remote GO yes STOP no");
  });
});
