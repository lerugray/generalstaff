// GeneralStaff — co-seats: single-instance lock (DESIGN.md §v11 "Single instance").
//
// The lock is a directory created atomically (`<seatDir>/lock/`) holding
// `owner.json` {pid, host, nonce, started}. The driver touches
// `<seatDir>/heartbeat` every tick. A same-host lock is live while its pid is
// alive and the heartbeat is under three ticks old; a lock from another host
// is live while its heartbeat is fresh. A stale lock is taken over by renaming
// it aside first (only one taker's rename succeeds), so two watchdogs cannot
// both start a driver. The driver releases the lock on every exit path.

import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { hostname } from "os";
import { join } from "path";
import { TICK_MS } from "./config";

export interface LockOwner {
  pid: number;
  host: string;
  nonce: string;
  started: string;
}

export interface LockDeps {
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  host?: string;
  pid?: number;
  tickMs?: number;
  /** Test hook: runs after a taker judged the lock stale and before its rename. */
  beforeTakeover?: () => void;
}

export type LockState =
  | { state: "none" }
  | { state: "live" | "stale"; owner: LockOwner | null; reason: string };

export type AcquireResult =
  | { ok: true; handle: LockHandle; tookOver: boolean }
  | { ok: false; reason: string; owner?: LockOwner | null };

export interface LockHandle {
  readonly nonce: string;
  /** Update the heartbeat file. */
  touch(): void;
  /** True while the lock on disk still carries this driver's nonce. */
  verify(): boolean;
  /** Remove the lock if it is still ours. Safe to call twice. */
  release(): void;
}

export function lockPath(dir: string): string {
  return join(dir, "lock");
}

export function heartbeatPath(dir: string): string {
  return join(dir, "heartbeat");
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function touchHeartbeat(dir: string, now: number = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(heartbeatPath(dir), new Date(now).toISOString() + "\n");
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Milliseconds since the heartbeat file was last touched, or null if never. */
export function heartbeatAgeMs(dir: string, now: number = Date.now()): number | null {
  const m = mtime(heartbeatPath(dir));
  return m === null ? null : Math.max(0, now - m);
}

export function readOwner(lockDir: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (
      typeof raw.pid === "number" &&
      typeof raw.host === "string" &&
      typeof raw.nonce === "string" &&
      typeof raw.started === "string"
    ) {
      return { pid: raw.pid, host: raw.host, nonce: raw.nonce, started: raw.started };
    }
    return null;
  } catch {
    return null;
  }
}

/** Is the lock held? Reads only; never changes anything. */
export function lockState(dir: string, deps: LockDeps = {}): LockState {
  const lock = lockPath(dir);
  if (!existsSync(lock)) return { state: "none" };
  const now = (deps.now ?? Date.now)();
  const tick = deps.tickMs ?? TICK_MS;
  const isAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const host = deps.host ?? hostname();
  const owner = readOwner(lock);

  // A lock being created has a directory and maybe no owner.json yet, and a
  // heartbeat left by an earlier run; the newest of the three marks its age.
  const stamps = [mtime(heartbeatPath(dir)), mtime(join(lock, "owner.json")), mtime(lock)].filter(
    (m): m is number => m !== null,
  );
  const newest = stamps.length ? Math.max(...stamps) : 0;
  const ageMs = Math.max(0, now - newest);
  const fresh = ageMs < 3 * tick;

  if (owner && owner.host === host && !isAlive(owner.pid)) {
    return { state: "stale", owner, reason: `pid ${owner.pid} on this host is not running` };
  }
  if (!fresh) {
    return {
      state: "stale",
      owner,
      reason: `heartbeat is ${Math.round(ageMs / 1000)} s old (limit ${Math.round((3 * tick) / 1000)} s)`,
    };
  }
  return {
    state: "live",
    owner,
    reason: owner ? `held by pid ${owner.pid} on ${owner.host}` : "lock is being created",
  };
}

/**
 * Take the lock, taking over a stale one by renaming it aside first. Returns
 * a handle, or why the lock is held. Never throws for a held or lost lock.
 */
export function acquireLock(dir: string, deps: LockDeps = {}): AcquireResult {
  mkdirSync(dir, { recursive: true });
  const lock = lockPath(dir);
  const nonce = randomUUID();
  let tookOver = false;

  const create = (): boolean => {
    try {
      mkdirSync(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };

  let created = create();
  if (!created) {
    const state = lockState(dir, deps);
    if (state.state === "live") {
      return { ok: false, reason: `a driver is already running (${state.reason})`, owner: state.owner };
    }
    if (state.state === "stale") {
      deps.beforeTakeover?.();
      const aside = `${lock}.stale.${nonce}`;
      try {
        renameSync(lock, aside);
      } catch {
        return { ok: false, reason: "another taker won the stale lock" };
      }
      // We must have moved the lock we judged. If it carries a different
      // owner, someone replaced it between our judgment and our rename: put
      // it back untouched and lose.
      const moved = readOwner(aside);
      if ((moved?.nonce ?? null) !== (state.owner?.nonce ?? null)) {
        try {
          renameSync(aside, lock);
        } catch {
          /* the live owner's verify() will notice and stand down */
        }
        return { ok: false, reason: "another taker won the stale lock" };
      }
      rmSync(aside, { recursive: true, force: true });
      tookOver = true;
    }
    created = create();
    if (!created) return { ok: false, reason: "another taker won the stale lock" };
  }

  const now = (deps.now ?? Date.now)();
  const owner: LockOwner = {
    pid: deps.pid ?? process.pid,
    host: deps.host ?? hostname(),
    nonce,
    started: new Date(now).toISOString(),
  };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner, null, 1) + "\n");
  touchHeartbeat(dir, now);

  let released = false;
  const handle: LockHandle = {
    nonce,
    touch: () => touchHeartbeat(dir, (deps.now ?? Date.now)()),
    verify: () => readOwner(lock)?.nonce === nonce,
    release: () => {
      if (released) return;
      released = true;
      if (readOwner(lock)?.nonce === nonce) {
        rmSync(lock, { recursive: true, force: true });
      }
    },
  };
  return { ok: true, handle, tookOver };
}
