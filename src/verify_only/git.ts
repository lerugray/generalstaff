// Pinned git invocation for the change-set digest and the verify-only path.
//
// Every call is argv-only (never a shell), has an explicit cwd, a wall-clock
// budget and a stdout byte cap, and runs under a cleared environment so that
// GIT_DIR, GIT_EXTERNAL_DIFF, user config and similar cannot redirect what is
// hashed. Hooks, fsmonitor and external diff drivers are switched off.

import { spawn, type ChildProcess } from "child_process";

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

export interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  stdin?: Buffer | string;
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** stdout exceeded the cap; the kept bytes must not be used. */
  truncated: boolean;
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  return new Promise<GitResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("git", [...args], {
        cwd: opts.cwd,
        env: opts.env ?? pinnedGitEnv(),
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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

    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    let truncated = false;
    let stderrBuf = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxStdout) {
        truncated = true;
        child.kill("SIGKILL");
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
        spawnError: err.message,
      });
    });
    child.on("close", (code) => {
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
