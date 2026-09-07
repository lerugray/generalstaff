// Module-level registry for currently-running engineer subprocesses.
//
// Lives separately from engineer.ts so session.ts (and the stop-watcher
// plumbing) can call killActiveEngineer without transitively importing
// state.ts / audit.ts — keeping the mid-cycle STOP path self-contained
// and test-helper-friendly (gs-131).
//
// Parallel sessions (max_parallel_slots > 1) may run multiple engineers
// concurrently; the registry is a collection keyed by child identity so
// registering B does not overwrite A, and clearing one leaves siblings.
//
// Unix engineers are spawned as leaders of their own process group and
// recorded here as GS-owned groups. Ownership is the unit of termination:
// STOP, timeout, and a dispatcher exit terminate the *group*, and the
// group is only considered settled once it has been observed empty (or
// SIGKILLed) — the leader's `close` on its own does not end ownership.

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
  clearTimeoutFn?: (id: unknown) => void;
  /** Inject process.kill for tests (Unix group-signal path). */
  killFn?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  /** SIGKILL escalation delay (ms). Default 10_000. */
  escalationMs?: number;
}

export const DEFAULT_ESCALATION_MS = 10_000;

type KillFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;

const defaultKillFn: KillFn = (pid, signal) => process.kill(pid, signal);

/** One GS-owned Unix process group, tracked from spawn until observed empty. */
interface OwnedGroup {
  child: KillableChild;
  pgid: number;
  /** TERM has been sent to the group (STOP, timeout, or settlement). */
  killRequested: boolean;
  /** Pending SIGKILL escalation timer, if any. */
  escalation: unknown;
  clearTimeoutFn: (id: unknown) => void;
}

/**
 * Children GS spawned with `detached: true` (new process group on Unix),
 * keyed by child identity. An entry is removed only when the group has
 * been observed gone (ESRCH) or after SIGKILL was sent to it — never on
 * the leader's `close` alone. Once removed, the pgid is never signalled
 * again by this module (no re-targeting of a reused id).
 */
const ownedGroups = new Map<KillableChild, OwnedGroup>();

/** Per-child SIGKILL escalation timers for non-owned children (child.kill path). */
const pendingEscalations = new WeakMap<object, unknown>();

/**
 * Record that `child` was spawned by GS as a detached Unix process-group
 * leader. Only children so marked may be signalled via negative PID.
 * The only production caller is the detached `spawn` in runEngineer;
 * never mark a child that was not spawned with `detached: true`.
 */
export function markOwnedUnixProcessGroup(child: KillableChild): void {
  const pid = child.pid;
  if (typeof pid !== "number" || !(pid > 0) || pid === process.pid) return;
  if (ownedGroups.has(child)) return;
  ownedGroups.set(child, {
    child,
    pgid: pid,
    killRequested: false,
    escalation: null,
    clearTimeoutFn: (id) => clearTimeout(id as NodeJS.Timeout),
  });
  syncProcessHooks();
}

/** True while GS still tracks `child`'s group as possibly alive. */
export function isOwnedUnixProcessGroupTracked(child: KillableChild): boolean {
  return ownedGroups.has(child);
}

function forgetOwnedGroup(entry: OwnedGroup): void {
  if (entry.escalation !== null) {
    try {
      entry.clearTimeoutFn(entry.escalation);
    } catch {
      /* timer already fired */
    }
    entry.escalation = null;
  }
  ownedGroups.delete(entry.child);
  syncProcessHooks();
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Probe the group with signal 0. Returns false only on ESRCH (group empty).
 * Any other outcome (success, EPERM, unexpected error) counts as alive so
 * we never declare a group gone on a failed probe.
 */
function groupAlive(pgid: number, killFn: KillFn): boolean {
  try {
    killFn(-pgid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== "ESRCH";
  }
}

function unrefTimer(id: unknown): void {
  const t = id as { unref?: () => void } | null | undefined;
  if (t && typeof t.unref === "function") t.unref();
}

/**
 * Send TERM to an owned group and arm one SIGKILL escalation. Idempotent
 * with respect to the timer: a repeated STOP re-sends TERM but never
 * stacks a second escalation. The escalation re-probes before signalling
 * and the entry is dropped after SIGKILL, so a pgid is never signalled
 * after it has been observed gone.
 */
function terminateOwnedGroup(entry: OwnedGroup, opts: KillChildTreeOptions): void {
  const killFn = opts.killFn ?? defaultKillFn;
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const escalationMs = opts.escalationMs ?? DEFAULT_ESCALATION_MS;
  if (opts.clearTimeoutFn) entry.clearTimeoutFn = opts.clearTimeoutFn;

  entry.killRequested = true;
  try {
    killFn(-entry.pgid, "SIGTERM");
  } catch (err) {
    if (errCode(err) === "ESRCH") {
      forgetOwnedGroup(entry);
      return;
    }
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  if (entry.escalation !== null) return;
  const id = setTimeoutFn(() => {
    entry.escalation = null;
    if (!ownedGroups.has(entry.child)) return;
    if (groupAlive(entry.pgid, killFn)) {
      try {
        killFn(-entry.pgid, "SIGKILL");
      } catch {
        /* raced to exit */
      }
    }
    // SIGKILL is the last signal this group will ever receive from us.
    forgetOwnedGroup(entry);
  }, escalationMs);
  entry.escalation = id;
  // The escalation must not keep the dispatcher alive on its own; the
  // process-exit hook below covers a group still alive at exit.
  unrefTimer(id);
}

function scheduleUnownedEscalation(
  child: KillableChild,
  setTimeoutFn: (cb: () => void, ms: number) => unknown,
  escalationMs: number,
): void {
  if (pendingEscalations.has(child)) return;
  const id = setTimeoutFn(() => {
    pendingEscalations.delete(child);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, escalationMs);
  pendingEscalations.set(child, id);
  unrefTimer(id);
}

function clearUnownedEscalation(child: KillableChild): void {
  const id = pendingEscalations.get(child);
  if (id !== undefined) {
    clearTimeout(id as NodeJS.Timeout);
    pendingEscalations.delete(child);
  }
}

// Kill the entire process tree rooted at `child`. On Windows,
// `child.kill("SIGTERM")` only kills the direct child (bash.exe);
// grandchildren (claude.exe spawned from run_bot.sh) keep running as
// orphans. This was observed 2026-04-17 when cycle 10's engineer timeout
// fired correctly but claude.exe ignored the kill and kept running for
// another ~15 minutes until taskkilled manually. On Unix, engineers are
// spawned detached into their own process group; we signal that group
// (-pid) only when GS owns it. Arbitrary callers without ownership never
// receive a negative-PID signal.
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
    return;
  }

  const owned = ownedGroups.get(child);
  if (owned) {
    terminateOwnedGroup(owned, opts);
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  scheduleUnownedEscalation(
    child,
    opts.setTimeoutFn ?? setTimeout,
    opts.escalationMs ?? DEFAULT_ESCALATION_MS,
  );
}

export interface OwnedGroupSettlement {
  /** Group members outlived the leader; TERM + escalation now cover them. */
  lingering: boolean;
}

/**
 * Called when the group leader's `close`/`error` fires. The leader closing
 * is not group termination: if members remain (e.g. a TERM-ignoring
 * descendant that redirected its stdio), the escalation stays armed — or
 * is armed now when no kill had been requested — so cancellation and
 * timeout still reap the whole owned group. Drops tracking only once the
 * group has been observed empty.
 */
export function settleOwnedUnixProcessGroup(
  child: KillableChild,
  opts: KillChildTreeOptions = {},
): OwnedGroupSettlement {
  const entry = ownedGroups.get(child);
  if (!entry) return { lingering: false };
  const killFn = opts.killFn ?? defaultKillFn;
  if (!groupAlive(entry.pgid, killFn)) {
    forgetOwnedGroup(entry);
    return { lingering: false };
  }
  if (!entry.killRequested) {
    terminateOwnedGroup(entry, opts);
  }
  return { lingering: true };
}

/**
 * After settlement requests termination, keep the engineer completion
 * pending until the group is observed gone or its escalation has fired.
 * The referenced poll also keeps an early-closing leader's unref'd kill
 * timer alive, so cycle verification/cleanup cannot race its descendants.
 */
export async function waitForOwnedUnixProcessGroup(
  child: KillableChild,
): Promise<void> {
  while (true) {
    const entry = ownedGroups.get(child);
    if (!entry) return;
    if (!groupAlive(entry.pgid, defaultKillFn)) {
      forgetOwnedGroup(entry);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

// --- Process-lifecycle hooks (installed only while GS owns live work) ---
//
// `detached: true` puts the engineer tree in its own session, so a
// terminal Ctrl-C or a `kill <dispatcher-pid>` no longer reaches it. While
// at least one engineer or owned group is tracked we hold one listener per
// signal; on the first signal we TERM every owned group, wait (bounded)
// for the groups to be observed gone, remove our listeners and re-raise
// the same signal so conventional termination semantics apply. A second
// signal during that wait force-kills immediately. Listeners are removed
// as soon as nothing is tracked, and only our own listener functions are
// ever added or removed.

const HANDLED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_POLL_MS = 25;
const SIGNAL_EXIT_GRACE_MS = DEFAULT_ESCALATION_MS + 2_000;

let hooksInstalled = false;
let signalInFlight: NodeJS.Signals | null = null;
let signalPoll: NodeJS.Timeout | null = null;

function forceKillOwnedGroups(): void {
  for (const entry of [...ownedGroups.values()]) {
    if (groupAlive(entry.pgid, defaultKillFn)) {
      try {
        defaultKillFn(-entry.pgid, "SIGKILL");
      } catch {
        /* raced to exit */
      }
    }
    forgetOwnedGroup(entry);
  }
}

function onProcessExit(): void {
  // Synchronous by contract: nothing GS owns may outlive the dispatcher.
  forceKillOwnedGroups();
}

function finishSignal(signal: NodeJS.Signals): void {
  if (signalPoll !== null) {
    clearTimeout(signalPoll);
    signalPoll = null;
  }
  signalInFlight = null;
  removeProcessHooks();
  try {
    process.kill(process.pid, signal);
  } catch {
    /* nothing else to do; another owner's listener may handle it */
  }
}

function nothingTracked(): boolean {
  return activeChildren.size === 0 && ownedGroups.size === 0;
}

function onSignal(signal: NodeJS.Signals): void {
  if (signalInFlight !== null) {
    // Second signal: the operator wants out now.
    console.error(`[generalstaff] ${signal} received again — force-killing owned engineer process group(s).`);
    forceKillOwnedGroups();
    finishSignal(signal);
    return;
  }
  signalInFlight = signal;
  console.error(
    `\n[generalstaff] ${signal} received — stopping ${activeChildren.size} active engineer(s) ` +
      `and ${ownedGroups.size} owned process group(s) before exit.`,
  );
  killActiveEngineer();
  const deadline = Date.now() + SIGNAL_EXIT_GRACE_MS;
  const tick = () => {
    signalPoll = null;
    if (nothingTracked() || Date.now() >= deadline) {
      if (!nothingTracked()) forceKillOwnedGroups();
      finishSignal(signal);
      return;
    }
    signalPoll = setTimeout(tick, SIGNAL_POLL_MS);
  };
  tick();
}

const signalHandlers: Record<string, () => void> = {
  SIGINT: () => onSignal("SIGINT"),
  SIGTERM: () => onSignal("SIGTERM"),
  SIGHUP: () => onSignal("SIGHUP"),
};

function installProcessHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const sig of HANDLED_SIGNALS) process.on(sig, signalHandlers[sig]!);
  process.on("exit", onProcessExit);
}

function removeProcessHooks(): void {
  if (!hooksInstalled) return;
  hooksInstalled = false;
  for (const sig of HANDLED_SIGNALS) process.off(sig, signalHandlers[sig]!);
  process.off("exit", onProcessExit);
}

function syncProcessHooks(): void {
  if (signalInFlight !== null) return; // finishSignal removes the hooks itself
  if (nothingTracked()) removeProcessHooks();
  else installProcessHooks();
}

// Active-engineer registry for the mid-cycle STOP watcher (gs-131).
// The session-level fs.watch on the STOP file runs outside runEngineer's
// Promise scope, so it needs a module-level handle to reach live children.
// Parallel slots may hold several engineers at once — collection, not slot.
const activeChildren = new Set<KillableChild>();
/** Most recently registered child; `getActiveEngineerChild` returns this. */
let lastRegistered: KillableChild | null = null;

/**
 * Register an active engineer, or clear the registry.
 *
 * - `setActiveEngineerChild(child)` adds without removing siblings.
 * - `setActiveEngineerChild(null)` clears ALL active entries and drops
 *   owned-group tracking without signalling anything (legacy single-slot
 *   "reset" callers and test teardown keep working).
 */
export function setActiveEngineerChild(child: KillableChild | null): void {
  if (child === null) {
    for (const c of activeChildren) clearUnownedEscalation(c);
    activeChildren.clear();
    lastRegistered = null;
    for (const entry of [...ownedGroups.values()]) forgetOwnedGroup(entry);
    syncProcessHooks();
    return;
  }
  activeChildren.add(child);
  lastRegistered = child;
  syncProcessHooks();
}

/** Remove one engineer; siblings remain registered. */
export function clearActiveEngineerChild(child: KillableChild): void {
  clearUnownedEscalation(child);
  activeChildren.delete(child);
  if (lastRegistered === child) {
    lastRegistered =
      activeChildren.size === 0
        ? null
        : [...activeChildren][activeChildren.size - 1]!;
  }
  syncProcessHooks();
}

/**
 * Returns the most recently registered active engineer, or null.
 * When multiple engineers run in parallel this is not "the only" child —
 * use killActiveEngineer to signal every registered owner.
 */
export function getActiveEngineerChild(): KillableChild | null {
  return lastRegistered;
}

/** Snapshot of all currently registered engineer children (test/helper). */
export function getActiveEngineerChildren(): KillableChild[] {
  return [...activeChildren];
}

/**
 * Kill every registered active engineer process tree, plus any owned
 * group whose leader already closed but whose members are still tracked.
 * Returns true if at least one target was signalled; false if none active.
 * Does not clear the registry — each child's `close` handler clears itself.
 */
export function killActiveEngineer(
  opts: KillChildTreeOptions = {},
): boolean {
  let signalled = false;
  for (const child of [...activeChildren]) {
    killChildTree(child, opts);
    signalled = true;
  }
  for (const entry of [...ownedGroups.values()]) {
    if (activeChildren.has(entry.child)) continue;
    terminateOwnedGroup(entry, opts);
    signalled = true;
  }
  return signalled;
}
