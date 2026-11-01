import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, utimesSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import {
  acquireLock,
  heartbeatAgeMs,
  heartbeatPath,
  lockPath,
  lockState,
  readOwner,
  type LockHandle,
} from "../../src/co_seat/lock";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
let dir: string;
beforeEach(() => {
  sb = makeSandbox();
  dir = join(sb.root, "seat");
});
afterEach(() => sb.cleanup());

function age(path: string, seconds: number) {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(path, t, t);
}
function ageLock(seconds: number) {
  for (const p of [heartbeatPath(dir), join(lockPath(dir), "owner.json"), lockPath(dir)]) {
    if (existsSync(p)) age(p, seconds);
  }
}
const dead = { isPidAlive: () => false };
function got(r: ReturnType<typeof acquireLock>): LockHandle {
  if (!r.ok) throw new Error(`expected the lock: ${r.reason}`);
  return r.handle;
}

describe("seat lock", () => {
  it("acquires a fresh lock and records pid, host, nonce and start time", () => {
    const r = acquireLock(dir, { host: "box-1" });
    const handle = got(r);
    const owner = readOwner(lockPath(dir))!;
    expect(owner).toMatchObject({ pid: process.pid, host: "box-1", nonce: handle.nonce });
    expect(Date.parse(owner.started)).not.toBeNaN();
    expect(existsSync(heartbeatPath(dir))).toBe(true);
    expect(r.ok && r.tookOver).toBe(false);
    expect(handle.verify()).toBe(true);
  });

  it("refuses while a same-host owner is alive with a fresh heartbeat", () => {
    got(acquireLock(dir, { host: "box-1" }));
    const second = acquireLock(dir, { host: "box-1" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain("already running");
      expect(second.owner?.pid).toBe(process.pid);
    }
    expect(lockState(dir, { host: "box-1" })).toMatchObject({ state: "live" });
  });

  it("release removes the lock, is idempotent and never removes another driver's lock", () => {
    const a = got(acquireLock(dir, { host: "h" }));
    a.release();
    expect(existsSync(lockPath(dir))).toBe(false);
    a.release();
    // After a takeover, the old handle must not delete the new owner's lock.
    const b = got(acquireLock(dir, { host: "h" }));
    rmSync(lockPath(dir), { recursive: true });
    const c = got(acquireLock(dir, { host: "h" }));
    expect(b.verify()).toBe(false);
    b.release();
    expect(existsSync(lockPath(dir))).toBe(true);
    expect(c.verify()).toBe(true);
    c.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("a same-host lock is stale when its pid is dead, however fresh the heartbeat", () => {
    got(acquireLock(dir, { host: "h" }));
    expect(lockState(dir, { host: "h", ...dead })).toMatchObject({ state: "stale" });
    const r = acquireLock(dir, { host: "h", ...dead });
    expect(r.ok && r.tookOver).toBe(true);
    // The renamed-aside directory is cleaned up.
    expect(readdirSync(dir).filter((n) => n.includes(".stale."))).toEqual([]);
  });

  it("a same-host lock is stale when the pid is alive but the heartbeat is over three ticks old", () => {
    got(acquireLock(dir, { host: "h" }));
    ageLock(200); // default tick is 60 s, so the limit is 180 s
    expect(lockState(dir, { host: "h" })).toMatchObject({ state: "stale" });
    ageLock(100);
    expect(lockState(dir, { host: "h" })).toMatchObject({ state: "live" });
  });

  it("a lock from another host is live while its heartbeat is fresh, whether or not the pid exists here", () => {
    got(acquireLock(dir, { host: "other-host", pid: 99999999 }));
    const r = acquireLock(dir, { host: "this-host", ...dead });
    expect(r.ok).toBe(false);
    expect(lockState(dir, { host: "this-host", ...dead })).toMatchObject({ state: "live" });
  });

  it("a lock from another host with an old heartbeat is stale and can be taken over", () => {
    got(acquireLock(dir, { host: "other-host" }));
    ageLock(500);
    const r = acquireLock(dir, { host: "this-host" });
    expect(r.ok && r.tookOver).toBe(true);
    expect(readOwner(lockPath(dir))!.host).toBe("this-host");
  });

  it("a lock directory with no owner.json is live while new and stale once old", () => {
    mkdirSync(lockPath(dir), { recursive: true });
    expect(lockState(dir, {})).toMatchObject({ state: "live" });
    expect(acquireLock(dir, {}).ok).toBe(false);
    age(lockPath(dir), 500);
    expect(lockState(dir, {})).toMatchObject({ state: "stale", owner: null });
    expect(acquireLock(dir, {}).ok).toBe(true);
  });

  it("an unreadable owner.json is treated like a missing one", () => {
    mkdirSync(lockPath(dir), { recursive: true });
    writeFileSync(join(lockPath(dir), "owner.json"), "{not json");
    age(join(lockPath(dir), "owner.json"), 500);
    age(lockPath(dir), 500);
    expect(lockState(dir, {})).toMatchObject({ state: "stale" });
  });

  it("sequential takers of one stale lock: the first wins, the second sees it live", () => {
    got(acquireLock(dir, { host: "h" }));
    const a = acquireLock(dir, { host: "h", ...dead });
    expect(a.ok).toBe(true);
    // B sees A's brand-new lock (A's pid is this process, alive).
    const b = acquireLock(dir, { host: "h" });
    expect(b.ok).toBe(false);
    expect(readOwner(lockPath(dir))!.nonce).toBe(got(a).nonce);
  });

  it("the rename takeover race: a taker that renames a lock replaced under it puts it back and loses", () => {
    got(acquireLock(dir, { host: "h" })); // the stale lock
    let winner: LockHandle | undefined;
    const loser = acquireLock(dir, {
      host: "h",
      ...dead,
      // After the loser judged the lock stale and before its rename, another watchdog
      // takes the stale lock over completely.
      beforeTakeover: () => {
        winner = got(acquireLock(dir, { host: "h", ...dead }));
      },
    });
    expect(loser.ok).toBe(false);
    expect(winner).toBeDefined();
    expect(winner!.verify()).toBe(true);
    expect(readOwner(lockPath(dir))!.nonce).toBe(winner!.nonce);
    expect(readdirSync(dir).filter((n) => n.includes(".stale."))).toEqual([]);
    winner!.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("touch updates the heartbeat", () => {
    const h = got(acquireLock(dir, { host: "h" }));
    age(heartbeatPath(dir), 100);
    expect(heartbeatAgeMs(dir)!).toBeGreaterThan(90_000);
    h.touch();
    expect(heartbeatAgeMs(dir)!).toBeLessThan(5_000);
  });
});
