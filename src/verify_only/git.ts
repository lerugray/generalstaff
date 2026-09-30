import { verificationTreeId, verificationGroupMembers, signalVerificationMembers } from "./process_tree";
// Pinned git invocation for the change-set digest and the verify-only path.
//
// Every call is argv-only (never a shell), has an explicit cwd, a wall-clock
// budget and a stdout byte cap, and runs under a cleared environment so that
// GIT_DIR, GIT_EXTERNAL_DIFF, user config and similar cannot redirect what is
// hashed. Hooks, fsmonitor and external diff drivers are switched off.

import { spawn, type ChildProcess } from "child_process";
import { AsyncLocalStorage } from "async_hooks";

export const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
];

const WINDOWS_PASSTHROUGH_ENV = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramFiles",
  "ProgramData",
];

/** The small environment every pinned child starts from. */
export function minimalChildEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const keys =
    process.platform === "win32"
      ? [...PASSTHROUGH_ENV, ...WINDOWS_PASSTHROUGH_ENV]
      : PASSTHROUGH_ENV;
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Environment for git: minimal, with user and system config disabled. */
export function pinnedGitEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return minimalChildEnv({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  });
}

/**
 * Config pins placed before the git subcommand. None of them changes the
 * bytes git prints under default configuration; they stop repository-local or
 * user configuration from changing them, and stop configured commands
 * (hooks, fsmonitor, attribute files) from running.
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  "--no-pager",
  "-c", `core.hooksPath=${NULL_DEVICE}`,
  "-c", "core.fsmonitor=false",
  "-c", `core.attributesFile=${NULL_DEVICE}`,
  "-c", "core.autocrlf=false",
  "-c", "core.quotePath=true",
];

/** Diff presentation pins (the gs-patch-digest/v1 contract). */
export const GIT_DIFF_PIN_ARGS: readonly string[] = [
  "-c", "diff.external=",
  "-c", "diff.noprefix=false",
  "-c", "diff.algorithm=myers",
  "-c", "diff.context=3",
  "-c", "diff.renames=true",
  "-c", "diff.renameLimit=1000",
  "-c", "diff.indentHeuristic=true",
  "-c", "diff.interHunkContext=0",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.suppressBlankEmpty=false",
  "-c", "diff.srcPrefix=a/",
  "-c", "diff.dstPrefix=b/",
  "-c", "diff.ignoreSubmodules=none",
  "-c", "diff.submodule=short",
  "-c", `diff.orderFile=${NULL_DEVICE}`,
];

const abortContext = new AsyncLocalStorage<AbortSignal | undefined>();
const inheritedGroupContext = new AsyncLocalStorage<{ owned: boolean; tail: Promise<void> }>();
/** A supervised verify CLI keeps its preflight/cleanup Git in the same group. */
export function withInheritedGitGroup<T>(fn: () => Promise<T>): Promise<T> {
  const owned = process.platform !== "win32" && verificationTreeId() === process.pid;
  return inheritedGroupContext.run({ owned, tail: Promise.resolve() }, fn);
}
const inheritedGitPids = new Set<number>();


/**
 * Every git call started inside `fn` (however deep) is stopped, process group
 * and all, when `signal` aborts. A call started after the abort returns at
 * once without spawning.
 */
export function withGitAbort<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return abortContext.run(signal, fn);
}

/** Run `fn` outside any abort context (cleanup after an abort must still run git). */
export function withoutGitAbort<T>(fn: () => Promise<T>): Promise<T> {
  return abortContext.run(undefined, fn);
}

const isWindows = process.platform === "win32";

function killGitGroup(child: ChildProcess): void {
  const pid = child.pid;
  try {
    if (pid !== undefined && !isWindows) signalGitPid(pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function gitGroupAlive(pid: number | undefined): boolean {
  if (pid === undefined || isWindows) return false;
  if (inheritedGitPids.has(pid)) {
    const members = verificationGroupMembers();
    return members === null || members.length > 0;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Longest a stopped git call waits for its process group to disappear. */
const GIT_REAP_WAIT_MS = 3000;

/**
 * Git child ids still owned here. Standalone helpers use detached groups;
 * supervised verify calls share the CLI group. Both paths await cleanup, and
 * the second-signal path forwards a force kill before exiting.
 */
const liveGitGroups = new Set<number>();

function registerGitGroup(pid: number | undefined): void {
  if (pid !== undefined) {
    liveGitGroups.add(pid);
    if (inheritedGroupContext.getStore()?.owned) inheritedGitPids.add(pid);
  }
}

/** Kill remaining members and await the bounded reap before releasing ownership. */
async function releaseGitGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (isWindows || !gitGroupAlive(pid)) {
    liveGitGroups.delete(pid);
    inheritedGitPids.delete(pid);
    return;
  }
  signalGitPid(pid, "SIGKILL");
  const deadline = Date.now() + GIT_REAP_WAIT_MS;
  while (liveGitGroups.has(pid) && gitGroupAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (liveGitGroups.has(pid) && gitGroupAlive(pid)) signalGitPid(pid, "SIGKILL");
  liveGitGroups.delete(pid);
  inheritedGitPids.delete(pid);
}

function signalGitPid(pid: number, signal: NodeJS.Signals): void {
  try {
    if (inheritedGitPids.has(pid)) signalVerificationMembers(signal);
    else if (!isWindows) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** Forward a terminal signal to every git process group that is still running. */
export function signalLiveGitGroups(signal: NodeJS.Signals): void {
  for (const pid of liveGitGroups) signalGitPid(pid, signal);
}

/**
 * SIGKILL every live git group before a second signal's process.exit.
 * This does not prove reaping: a synchronous wait would block the event loop
 * from reaping our direct children and count their zombies as live groups.
 */
export function killAndReapLiveGitGroups(): void {
  for (const pid of liveGitGroups) signalGitPid(pid, "SIGKILL");
  liveGitGroups.clear();
}

/** Ordinary CLI exits can yield to the event loop and await owned group shutdown. */
export async function reapLiveGitGroups(): Promise<void> {
  for (const pid of liveGitGroups) signalGitPid(pid, "SIGKILL");
  await Promise.all([...liveGitGroups].map(releaseGitGroup));
}

export interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  stdin?: Buffer | string;
  /** Overrides the ambient abort context (see withGitAbort). */
  signal?: AbortSignal;
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** stdout exceeded the cap; the kept bytes must not be used. */
  truncated: boolean;
  /** The call was stopped by an abort signal; its process group was killed. */
  aborted?: boolean;
  spawnError?: string;
}

/** Run git with the hardening pins. `args` starts at the subcommand. */
export function runGit(
  args: readonly string[],
  opts: GitRunOptions,
): Promise<GitResult> {
  return runGitRaw([...GIT_HARDENING_ARGS, ...args], opts);
}

/** Run git with exactly `args` (no hardening pins added). */
export function runGitRaw(
  args: readonly string[],
  opts: GitRunOptions,
): Promise<GitResult> {
  const context = inheritedGroupContext.getStore();
  if (!context?.owned) return runGitRawInner(args, opts);
  // A group sweep may only follow the last active Git call. Serialize calls
  // sharing the CLI group so one completed diff cannot kill a sibling diff.
  const run = context.tail.then(() => runGitRawInner(args, opts));
  context.tail = run.then(() => undefined, () => undefined);
  return run;
}

function runGitRawInner(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const signal = opts.signal ?? abortContext.getStore();
  return new Promise<GitResult>((resolve) => {
    if (signal?.aborted) {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        timedOut: false,
        truncated: false,
        aborted: true,
      });
      return;
    }
    let child: ChildProcess;
    try {
      // Supervised verify calls inherit the CLI group; standalone helpers
      // retain their owned Git groups and existing cleanup contract.
      child = spawn("git", [...args], {
        cwd: opts.cwd,
        env: opts.env ?? pinnedGitEnv(),
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: !isWindows && !inheritedGroupContext.getStore()?.owned,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        timedOut: false,
        truncated: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    registerGitGroup(child.pid);

    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    let truncated = false;
    let stderrBuf = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = async (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await releaseGitGroup(child.pid);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGitGroup(child);
    }, timeoutMs);

    // Finish owns the bounded group reap on every exit, including an abort:
    // the caller may remove the tree git was working in right away.
    const onAbort = () => {
      aborted = true;
      killGitGroup(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      void finish({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: stderrBuf,
        timedOut,
        truncated,
        aborted: true,
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxStdout) {
        truncated = true;
        killGitGroup(child);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_STDERR_BYTES) {
        stderrBuf += chunk.toString("utf8");
      }
    });
    child.on("error", (err) => {
      finish({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: stderrBuf,
        timedOut,
        truncated,
        aborted,
        spawnError: err.message,
      });
    });
    child.on("close", (code) => {
      if (aborted) return;
      finish({
        code,
        stdout: truncated ? Buffer.alloc(0) : Buffer.concat(stdoutChunks),
        stderr: stderrBuf,
        timedOut,
        truncated,
      });
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* git may exit before reading all input */
      });
      child.stdin.end(opts.stdin);
    }
  });
}

/** Remove control characters and cap length: one safe line for a message. */
export function scrubLine(text: string, max = 300): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
