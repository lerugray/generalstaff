// Module-level registry for the currently-running engineer subprocess.
//
// Lives separately from engineer.ts so session.ts (and the stop-watcher
// plumbing) can call killActiveEngineer without transitively importing
// state.ts / audit.ts — keeping the mid-cycle STOP path self-contained
// and test-helper-friendly (gs-131).

import { spawnSync as realSpawnSync } from "child_process";

// Minimal ChildProcess surface used by killChildTree — kept narrow so tests
// can pass a fake without fabricating an entire ChildProcess instance.
export interface KillableChild {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface KillChildTreeOptions {
  platform?: NodeJS.Platform;
  spawnSyncFn?: typeof import("child_process").spawnSync;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
}

// Kill the entire process tree rooted at `child`. On Windows,
// `child.kill("SIGTERM")` only kills the direct child (bash.exe);
// grandchildren (claude.exe spawned from run_bot.sh) keep running as
// orphans. This was observed 2026-04-17 when cycle 10's engineer timeout
// fired correctly but claude.exe ignored the kill and kept running for
// another ~15 minutes until taskkilled manually. On *nix the signal
// propagates through the process group when the shell forwards it; on
// Windows we need taskkill /T /F to reach the tree.
export function killChildTree(
  child: KillableChild,
  opts: KillChildTreeOptions = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32" && child.pid) {
    const spawnSyncFn = opts.spawnSyncFn ?? realSpawnSync;
    spawnSyncFn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
    const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    setTimeoutFn(() => child.kill("SIGKILL"), 10_000);
  }
}

// Active-engineer registry for the mid-cycle STOP watcher (gs-131).
// The session-level fs.watch on the STOP file runs outside runEngineer's
// Promise scope, so it needs a module-level handle to reach the live
// child. At most one engineer runs at a time — cycles are sequential —
// so a single slot suffices.
let activeChild: KillableChild | null = null;

export function setActiveEngineerChild(child: KillableChild | null): void {
  activeChild = child;
}

export function clearActiveEngineerChild(child: KillableChild): void {
  if (activeChild === child) activeChild = null;
}

export function getActiveEngineerChild(): KillableChild | null {
  return activeChild;
}

export function killActiveEngineer(
  opts: KillChildTreeOptions = {},
): boolean {
  if (!activeChild) return false;
  killChildTree(activeChild, opts);
  return true;
}
