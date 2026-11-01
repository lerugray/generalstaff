// GeneralStaff — co-seats: a short exclusive lock around a read-modify-write.
//
// A directory created atomically (mkdir) is the lock. Waiters retry for a
// while; a lock older than `staleMs` (its holder died) is broken by renaming it
// aside first, and put back if what was renamed turns out to be fresh (another
// waiter broke the stale one and took the lock between our look and our rename).
// Synchronous on purpose: the callers are CLI commands that must not interleave.

import { mkdirSync, renameSync, rmSync, statSync } from "fs";
import { dirname } from "path";

export interface DirLockOptions {
  /** A lock directory older than this is a dead holder's. Default 10 s. */
  staleMs?: number;
  /** Give up waiting after this long. Default 30 s. */
  waitMs?: number;
}

function sleepSync(ms: number): void {
  try {
    Bun.sleepSync(ms);
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

export function withDirLock<T>(lockDir: string, fn: () => T, opts: DirLockOptions = {}): T {
  const staleMs = opts.staleMs ?? 10_000;
  const waitMs = opts.waitMs ?? 30_000;
  mkdirSync(dirname(lockDir), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(lockDir).mtimeMs;
    } catch {
      continue; // released between our mkdir and our stat
    }
    if (ageMs > staleMs) {
      const aside = `${lockDir}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(lockDir, aside);
        let movedAge = Number.POSITIVE_INFINITY;
        try {
          movedAge = Date.now() - statSync(aside).mtimeMs;
        } catch {
          /* gone */
        }
        if (movedAge <= staleMs) {
          // We moved a fresh lock another waiter had just taken: put it back.
          try {
            renameSync(aside, lockDir);
          } catch {
            /* the holder's finally will find nothing to remove */
          }
        } else {
          rmSync(aside, { recursive: true, force: true });
        }
      } catch {
        /* another waiter broke it first */
      }
      continue;
    }
    if (Date.now() - started > waitMs) {
      throw new Error(`could not take the lock ${lockDir} (held for over ${Math.round(waitMs / 1000)} s)`);
    }
    sleepSync(15 + Math.floor(Math.random() * 25));
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
