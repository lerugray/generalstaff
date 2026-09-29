// Best-effort per-project lock for `cycle verify`.
//
// One verify-only check runs per project at a time. The lock is a file
// created exclusively inside the project's verify directory; it names the
// owning process and cycle. A lock whose owner is gone, or that is older than
// any check could legitimately run, is stale and is replaced. This is a
// courtesy against two callers double-starting, not a security boundary.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "fs";
import { join } from "path";
import { VerifyRefusal } from "./refusal";

export interface LockInfo {
  pid: number;
  cycleId: string;
  startedAt: string;
  /** Wall-clock ms after which the lock is stale whatever its owner does. */
  expiresAtMs: number;
}

export interface VerifyLock {
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.cycleId === "string" &&
      typeof parsed.expiresAtMs === "number"
    ) {
      return parsed as LockInfo;
    }
  } catch {
    /* unreadable or half-written: treated as stale below */
  }
  return null;
}

export function acquireVerifyLock(
  verifyRoot: string,
  cycleId: string,
  maxRunMs: number,
): VerifyLock {
  mkdirSync(verifyRoot, { recursive: true, mode: 0o700 });
  const path = join(verifyRoot, ".lock");
  const info: LockInfo = {
    pid: process.pid,
    cycleId,
    startedAt: new Date().toISOString(),
    expiresAtMs: Date.now() + maxRunMs,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return {
        release() {
          const current = readLock(path);
          if (current !== null && current.cycleId !== cycleId) return;
          rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = readLock(path);
      const stale =
        held === null || !pidAlive(held.pid) || Date.now() > held.expiresAtMs;
      if (!stale) {
        throw new VerifyRefusal(
          "verify_in_progress",
          `another verify-only check is already running for this project (cycle ${held!.cycleId})`,
        );
      }
      rmSync(path, { force: true });
    }
  }
  throw new VerifyRefusal(
    "verify_in_progress",
    "another verify-only check is starting for this project",
  );
}
