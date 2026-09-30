// Global git excludes resolution (REAL #1 of the structural review).
//
// `gs-patch-digest/v1`'s U listing — the untracked files bound by the digest —
// is defined as "not ignored" output of `git ls-files --others
// --exclude-standard`. Git resolves *ignore rules* from three sources: the
// tree's own .gitignore chain, the `--exclude` paths pinned by the caller, and
// the user's global excludes file (core.excludesFile, or the XDG/git default).
// The pinned child environment (GIT_CONFIG_GLOBAL=/dev/null) removes the
// third source, so a locally-ignored secret (a .env in the user's global
// ignores) silently became part of the change-set on the machine that made the
// bundle, and the digest bound its bytes anyway.
//
// Fix: resolve the user's effective global excludes file ONCE per run — under
// the calling process's own environment, because resolution itself is a read
// of user config — then pin it explicitly (`-c core.excludesFile=<resolved>`,
// or the null device when there is none) on every git call that decides U, so
// bundle, digest and materialize all agree about which files U holds. The
// resolved path and the SHA-256 of its contents are recorded in the bundle
// info and the cycle receipt.

import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { VerifyRefusal } from "./refusal";
import { DigestError, gitFailure } from "./digest";
import { DEFAULT_GIT_TIMEOUT_MS, NULL_DEVICE, runGitRaw } from "./git";

export interface GlobalExcludes {
  /** Where the path came from: `git config --global`, the XDG variable, the
   * default location, or no global excludes file at all. */
  source: "config" | "xdg" | "default" | "none";
  /** Absolute path of the effective global excludes file, null when none. */
  path: string | null;
  /** SHA-256 of the file's bytes, null when there is no readable file. */
  sha256: string | null;
}

function envHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home;
}

/**
 * Resolve the user's effective global excludes file. Must run under the
 * calling process's own environment: reading user config is the point. Fails
 * closed (with the git failure code) when git itself cannot answer — an indeterminate
 * answer must not become a change-set that skips ignored files.
 */
export async function resolveGlobalExcludes(
  opts: { timeoutMs?: number } = {},
): Promise<GlobalExcludes> {
  let fromConfig: string | null = null;
  const run = await runGitRaw(
    ["config", "--global", "--path", "--get", "core.excludesFile"],
    {
      cwd: process.cwd(),
      env: fullCallerEnv(),
      timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1024,
    },
  );
  // Exit 1 means the key is unset only if the command and its cleanup completed.
  if (run.reaped === false || run.spawnError || run.code === null ||
      run.timedOut || run.aborted || run.truncated || (run.code !== 0 && run.code !== 1)) {
    const error = gitFailure("config --global --get core.excludesFile", run);
    throw new DigestError(error.code,
      `could not resolve the user's global git excludes file: ${error.message}`);
  }
  if (run.code === 0) {
    const line = run.stdout.toString("utf8").trim();
    if (line !== "") fromConfig = line.split("\n")[0].trim();
  }

  let source: GlobalExcludes["source"];
  let path: string | null;
  if (fromConfig !== null) {
    source = "config";
    path = fromConfig;
  } else {
    // Matches git: a set, non-empty XDG_CONFIG_HOME replaces ~/.config, it is
    // not searched in addition to it.
    const xdgRoot =
      process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== ""
        ? process.env.XDG_CONFIG_HOME
        : null;
    const home = envHome();
    const ignorePath =
      xdgRoot !== null
        ? join(xdgRoot, "git", "ignore")
        : home !== ""
          ? join(home, ".config", "git", "ignore")
          : null;
    if (ignorePath !== null && existsSync(ignorePath)) {
      source = xdgRoot !== null ? "xdg" : "default";
      path = ignorePath;
    } else {
      source = "none";
      path = null;
    }
  }
  return { source, path, sha256: sha256OfMaybeFile(path) };
}

function sha256OfMaybeFile(path: string | null): string | null {
  if (path === null) return null;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Config pin for git calls that decide the change-set (U). `path === null`
 * pins the null device, so no global excludes file leaks in from anywhere
 * else. Prepend before the git subcommand, like the other pins.
 */
export function excludesFilePinArgs(path: string | null): string[] {
  return ["-c", `core.excludesFile=${path ?? NULL_DEVICE}`];
}

/** The calling process's environment, as git's own resolution would see it. */
function fullCallerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A supplied pin is authoritative; never re-resolve it from HOME/XDG. */
export function checkExcludesPin(pin: { path: string | null; sha256: string | null }): GlobalExcludes {
  if (pin.path === null && pin.sha256 === null) return { source: "none", ...pin };
  if (pin.path === null || pin.sha256 === null || sha256OfMaybeFile(pin.path) !== pin.sha256) {
    throw new VerifyRefusal("excludes_mismatch", "the pinned global excludes file is missing, unreadable, or has changed");
  }
  return { source: "config", ...pin };
}
