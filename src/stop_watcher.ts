// gs-131: mid-cycle STOP file detection.
//
// isStopFilePresent() is only checked at cycle boundaries in session.ts —
// a STOP written mid-engineer would sit unread until the engineer finished
// on its own (possibly 30+ minutes later). This module watches the STOP
// path's parent directory and invokes a callback the moment the file
// appears, so the session can kill the active engineer subprocess
// immediately and mark the cycle as skipped.
//
// The watcher is injectable for tests — a fake `watchFn` lets the test
// fire the listener synchronously without touching the filesystem.

import { watch as realWatch, existsSync } from "fs";
import { basename, dirname } from "path";

export interface StopWatcher {
  close(): void;
}

export type FsWatchListener = (
  eventType: string,
  filename: string | null,
) => void;

export interface FsWatchLike {
  close(): void;
}

export type WatchFn = (dir: string, listener: FsWatchListener) => FsWatchLike;

export interface StartStopFileWatcherOptions {
  watchFn?: WatchFn;
  existsFn?: (p: string) => boolean;
}

export function startStopFileWatcher(
  stopPath: string,
  onStop: () => void,
  opts: StartStopFileWatcherOptions = {},
): StopWatcher {
  const watchFn = opts.watchFn ?? defaultWatchFn;
  const existsFn = opts.existsFn ?? existsSync;
  const dir = dirname(stopPath);
  const name = basename(stopPath);
  let fired = false;

  const fs = watchFn(dir, (_event, filename) => {
    if (fired) return;
    // On some platforms filename is null — fall through to existsFn in that
    // case rather than filtering by name.
    if (filename && filename !== name) return;
    if (!existsFn(stopPath)) return;
    fired = true;
    try {
      onStop();
    } catch {
      /* watcher callbacks must never crash the session */
    }
  });

  return {
    close: () => {
      try {
        fs.close();
      } catch {
        /* idempotent close */
      }
    },
  };
}

const defaultWatchFn: WatchFn = (dir, listener) => {
  try {
    const w = realWatch(dir, (event, filename) => {
      // Node's fs.watch filename is string | Buffer | null; normalize.
      let name: string | null = null;
      if (typeof filename === "string") {
        name = filename;
      } else if (filename) {
        name = (filename as Buffer).toString();
      }
      listener(event, name);
    });
    return w;
  } catch {
    // Directory missing or platform-specific fs.watch failure — degrade
    // gracefully rather than crash the session. The outer-loop
    // cycle-boundary isStopFilePresent() check is still a safety net.
    return { close: () => {} };
  }
};
