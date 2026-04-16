// GeneralStaff — safety module (build step 5)
// STOP file, working-tree-clean check, hands_off glob, isBotRunning (Q3)

import { existsSync, statSync, readdirSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { $ } from "bun";
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

// --- Working tree clean check ---

export async function isWorkingTreeClean(projectPath: string): Promise<{
  clean: boolean;
  reason?: string;
}> {
  try {
    const result =
      await $`git -C ${projectPath} status --porcelain`.text();
    const trimmed = result.trim();
    if (trimmed.length === 0) {
      return { clean: true };
    }
    return {
      clean: false,
      reason: `Uncommitted changes in ${projectPath}:\n${trimmed}`,
    };
  } catch (e) {
    return {
      clean: false,
      reason: `Failed to check git status for ${projectPath}: ${e}`,
    };
  }
}

// --- Hands-off glob matching ---

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
  return new RegExp(regex);
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
