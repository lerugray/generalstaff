// GeneralStaff — safety module (build step 5)
// STOP file, working-tree-clean check, hands_off glob, isBotRunning (Q3)

import { existsSync, statSync, readdirSync, mkdirSync, readFileSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";
import { dirname, join } from "path";
import { $ } from "bun";
import { spawnSync as realSpawnSync } from "child_process";
import type { ProjectConfig, BotRunningResult } from "./types";
import { getRootDir } from "./state";

// --- STOP file ---

function stopFilePath(): string {
  return join(getRootDir(), "STOP");
}

export async function isStopFilePresent(): Promise<boolean> {
  return existsSync(stopFilePath());
}

export async function createStopFile(): Promise<void> {
  await writeFile(
    stopFilePath(),
    `STOP — created ${new Date().toISOString()}\n`,
    "utf8",
  );
}

export async function removeStopFile(): Promise<void> {
  const path = stopFilePath();
  if (existsSync(path)) {
    await unlink(path);
  }
}

// --- Session PID tracking ---
// gs-119: record the running session's PID so `stop --force` can locate
// and terminate it. Written at session start, removed on clean exit.
// Best-effort — if the process is killed mid-cycle the file is left
// stale, which is why stop --force ignores failures and why the file
// is overwritten, not appended to, on each session start.

export function sessionPidFilePath(): string {
  return join(getRootDir(), "state", "session.pid");
}

export async function writeSessionPid(pid: number): Promise<void> {
  const path = sessionPidFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  await writeFile(path, String(pid), "utf8");
}

export function readSessionPid(): number | null {
  const path = sessionPidFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function removeSessionPid(): Promise<void> {
  const path = sessionPidFilePath();
  if (existsSync(path)) {
    await unlink(path);
  }
}

// --- Force-stop (gs-119) ---

export interface KillProcessTreeOptions {
  spawnSyncFn?: typeof realSpawnSync;
  killFn?: (pid: number, signal?: NodeJS.Signals | number) => void;
  platform?: NodeJS.Platform;
}

export interface KillProcessTreeResult {
  killed: boolean;
  method: "taskkill" | "signal";
  error?: string;
}

export function killProcessTree(
  pid: number,
  opts: KillProcessTreeOptions = {},
): KillProcessTreeResult {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const spawnSyncFn = opts.spawnSyncFn ?? realSpawnSync;
      const result = spawnSyncFn(
        "taskkill",
        ["/pid", String(pid), "/f", "/t"],
        { stdio: "ignore" },
      );
      if (result.error) {
        return {
          killed: false,
          method: "taskkill",
          error: String(result.error),
        };
      }
      // taskkill exits non-zero when the pid no longer exists. Treat
      // "already gone" as success — stop --force is idempotent.
      return { killed: true, method: "taskkill" };
    }
    const killFn =
      opts.killFn ?? ((p: number, s?: NodeJS.Signals | number) => process.kill(p, s));
    killFn(pid, "SIGTERM");
    return { killed: true, method: "signal" };
  } catch (e) {
    return {
      killed: false,
      method: platform === "win32" ? "taskkill" : "signal",
      error: String(e),
    };
  }
}

export interface StopForceResult {
  stopFileCreated: boolean;
  pid: number | null;
  killed: boolean;
  method?: "taskkill" | "signal";
  error?: string;
}

export async function stopForce(
  opts: KillProcessTreeOptions = {},
): Promise<StopForceResult> {
  await createStopFile();
  const pid = readSessionPid();
  if (pid === null) {
    return { stopFileCreated: true, pid: null, killed: false };
  }
  const result = killProcessTree(pid, opts);
  // Clear the pid file regardless — the process is either dead or gone.
  await removeSessionPid();
  return {
    stopFileCreated: true,
    pid,
    killed: result.killed,
    method: result.method,
    error: result.error,
  };
}

// --- Working tree clean check ---

// gs-178: paths exempt from the working-tree-clean check. These files are
// expected to mutate during normal session execution (audit log appends
// most prominently) and would otherwise block cross-project cycle chaining
// within a session — once cycle N writes state/<id>/PROGRESS.jsonl, cycle
// N+1's preflight check sees a dirty tree and refuses to start, even for
// the OTHER project that wasn't being audited. Hard Rule #9 (open audit
// log) means we keep the file in git; this exemption ensures the audit
// trail's append rate doesn't destroy session-level chaining.
//
// Narrow on purpose: only the per-project audit log path. Anything else
// under state/ (tasks.json, MISSION.md, fleet_state.json, session.pid,
// cycle artifacts) still trips the dirty-tree check, preserving the
// original safety surface for genuine state mutations.
const CLEAN_TREE_EXEMPT_PATTERNS: RegExp[] = [
  /^state\/[^/]+\/PROGRESS\.jsonl$/,
];

export function isExemptFromCleanTreeCheck(filePath: string): boolean {
  return CLEAN_TREE_EXEMPT_PATTERNS.some((re) => re.test(filePath));
}

// Parse a `git status --porcelain` line and extract the changed file
// path. Porcelain v1 format is `XY path` where XY is two status chars
// (space-padded if not staged/not unstaged respectively), then a single
// space, then the path. For renames (`R  old -> new`) we keep the new
// path. Untracked files (`?? path`) use the same column layout.
function porcelainPath(line: string): string {
  // First two chars are status; char 2 is the separating space; path
  // starts at char 3.
  const after = line.slice(3);
  // Renames look like "old -> new"; the file we care about is "new"
  // because that's what's actually present in the tree.
  const arrow = after.indexOf(" -> ");
  return arrow >= 0 ? after.slice(arrow + 4) : after;
}

// Filter raw `git status --porcelain` output to drop lines for files
// the clean-tree check exempts (gs-178). Returns the filtered output
// (still in porcelain format) — empty string means tree is effectively
// clean for the dispatcher's purposes.
export function filterCleanTreePorcelain(porcelainOutput: string): string {
  return porcelainOutput
    .split("\n")
    .filter((line) => {
      if (line.length === 0) return false;
      const path = porcelainPath(line);
      return !isExemptFromCleanTreeCheck(path);
    })
    .join("\n");
}

export async function isWorkingTreeClean(projectPath: string): Promise<{
  clean: boolean;
  reason?: string;
}> {
  try {
    const result =
      await $`git -C ${projectPath} status --porcelain`.text();
    const filtered = filterCleanTreePorcelain(result.trim());
    if (filtered.length === 0) {
      return { clean: true };
    }
    return {
      clean: false,
      reason: `Uncommitted changes in ${projectPath}:\n${filtered}`,
    };
  } catch (e) {
    return {
      clean: false,
      reason: `Failed to check git status for ${projectPath}: ${e}`,
    };
  }
}

// --- Hands-off glob matching ---

// Windows filesystems (NTFS, default) are case-insensitive, so a hands-off
// pattern `src/reviewer.ts` would not match a diff path of `Src/Reviewer.ts`
// using a case-sensitive regex — which is a hands-off-bypass surface on
// every Windows-hosted install. Security audit 2026-04-19 (HIGH).
// Detect once at module load; platform doesn't change during a process.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function globToRegex(pattern: string): RegExp {
  // Convert a simple glob pattern to a regex
  // Supports: * (any chars except /), ** (any chars including /), ? (one char)
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // skip trailing /
        continue;
      }
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if (c === ".") {
      regex += "\\.";
    } else if (c === "/") {
      regex += "/";
    } else {
      regex += c;
    }
    i++;
  }
  // If the pattern ends with /, match anything under that directory
  if (pattern.endsWith("/")) {
    regex += ".*";
  }
  regex += "$";
  // Case-insensitive match on case-insensitive filesystems (Win32, macOS
  // default HFS+/APFS). On Linux we keep case-sensitive since the
  // filesystem is. Prevents the bypass where a bot commits
  // `Src/Reviewer.ts` past a `src/reviewer.ts` hands-off pattern.
  return new RegExp(regex, CASE_INSENSITIVE_FS ? "i" : "");
}

export function matchesHandsOff(
  filePath: string,
  handsOff: string[],
): string | null {
  for (const pattern of handsOff) {
    const re = globToRegex(pattern);
    if (re.test(filePath)) {
      return pattern;
    }
  }
  return null;
}

// --- Concurrent-run detection (Q3: three-signal check) ---

export function isBotRunning(project: ProjectConfig): BotRunningResult {
  if (project.concurrency_detection === "none") {
    return { running: false };
  }

  // Generic worktree check — works for any project using .bot-worktree
  if (project.concurrency_detection === "worktree") {
    const worktreePath = join(project.path, ".bot-worktree");
    // A real git worktree has a .git file; an empty leftover dir doesn't
    const gitMarker = join(worktreePath, ".git");
    if (existsSync(worktreePath) && existsSync(gitMarker)) {
      const stat = statSync(worktreePath);
      const ageMin = (Date.now() - stat.mtimeMs) / 60_000;
      if (ageMin < 10) {
        return {
          running: true,
          reason: `.bot-worktree exists, modified ${ageMin.toFixed(0)} min ago`,
        };
      }
    }
    return { running: false };
  }

  // catalogdna-specific: three-signal check
  if (project.concurrency_detection !== "catalogdna") {
    return { running: false };
  }

  // Signal 1: .bot-worktree exists and is fresh (< 10 min)
  const worktreePath = join(project.path, ".bot-worktree");
  if (existsSync(worktreePath)) {
    const stat = statSync(worktreePath);
    const ageMin = (Date.now() - stat.mtimeMs) / 60_000;
    if (ageMin < 10) {
      return {
        running: true,
        reason: `.bot-worktree exists, modified ${ageMin.toFixed(0)} min ago`,
      };
    }
  }

  // Signal 2: bot_status.md shows active task (not idle)
  const statusPath = join(project.path, "bot_status.md");
  if (existsSync(statusPath)) {
    try {
      const content = require("fs").readFileSync(statusPath, "utf8");
      const hasCurrentTask = /Current task:/.test(content);
      const isIdle = /Status:\s*\*?\*?\s*idle/i.test(content);
      if (hasCurrentTask && !isIdle) {
        return {
          running: true,
          reason: "bot_status.md shows active task (not idle)",
        };
      }
    } catch {
      // Can't read status file — not a signal
    }
  }

  // Signal 3: heartbeat sentinel is fresh (< 20 min)
  const logsDir = join(project.path, "logs");
  if (existsSync(logsDir)) {
    try {
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("heartbeat_") || !f.endsWith(".sentinel")) continue;
        const stat = statSync(join(logsDir, f));
        const ageMin = (Date.now() - stat.mtimeMs) / 60_000;
        if (ageMin < 20) {
          return {
            running: true,
            reason: `recent heartbeat sentinel: ${f}`,
          };
        }
      }
    } catch {
      // Can't read logs dir — not a signal
    }
  }

  return { running: false };
}
