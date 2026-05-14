#!/usr/bin/env bun
// GeneralStaff — heartbeat supervisor
//
// Port of upstream claude-heartbeat supervisor.js with GS conventions +
// the --permission-mode auto launch shape (per
// feedback_claude_launch_use_permission_mode_auto memory).
//
// Spawns claude in interactive mode with the Stop hook configured to fire
// src/heartbeat/hook.ts. Polls for the .restart flag (heartbeat-driven
// fresh-context restart). Watchdog kills stuck sessions.
//
// Usage:
//   bun src/heartbeat/supervisor.ts [model] [prompt]
//   bun src/heartbeat/supervisor.ts sonnet "You are in GS heartbeat mode..."
//
// Env:
//   WATCHDOG_TIMEOUT       — seconds before a stuck session is killed
//                            (default: 1800 = 30min, covers long GS cycles)
//   HEARTBEAT_IO_DIR       — override io/ directory
//   HEARTBEAT_SETTINGS     — path to settings JSON passed via --settings
//   HEARTBEAT_SYSTEM_FILE  — path to append-system-prompt file
//
// Permission mode is FIXED to `auto`. To force a different mode, edit this
// file. The bypass-permissions mode is intentionally NOT exposed as an env
// override; if you need that, you're past the safety net this supervisor
// is supposed to provide.

import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const IS_WIN = process.platform === "win32";
const IO_DIR = process.env.HEARTBEAT_IO_DIR
  ? resolve(process.env.HEARTBEAT_IO_DIR)
  : resolve(import.meta.dir, "..", "..", "io");

const RESTART_FLAG = join(IO_DIR, ".restart");
const LAST_TICK_FILE = join(IO_DIR, ".last-tick");
const PID_FILE = join(IO_DIR, ".supervisor.pid");
const CHILD_PID_FILE = join(IO_DIR, ".child.pid");

const MODEL = process.argv[2] ?? "sonnet";
const PROMPT =
  process.argv[3] ??
  "You are in GS heartbeat mode. The Stop hook will keep you alive across turns. Wait for inbox messages and act on them per CLAUDE.md.";

const WATCHDOG_TIMEOUT_MS =
  parseInt(process.env.WATCHDOG_TIMEOUT ?? "1800", 10) * 1000;

const SETTINGS_FILE = process.env.HEARTBEAT_SETTINGS;
const SYSTEM_PROMPT_FILE = process.env.HEARTBEAT_SYSTEM_FILE;

function ensureIoDir(): void {
  if (!existsSync(IO_DIR)) {
    mkdirSync(IO_DIR, { recursive: true });
  }
}

function cleanup(): void {
  try {
    unlinkSync(RESTART_FLAG);
  } catch {
    /* not present */
  }
}

function killProcess(pid: number): void {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /F /T 2>nul`, {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already dead */
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH 2>nul`, {
        encoding: "utf8",
        windowsHide: true,
      });
      return out.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

function reapOrphans(): void {
  for (const pidFile of [CHILD_PID_FILE, PID_FILE]) {
    try {
      const oldPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (oldPid && oldPid !== process.pid && isProcessRunning(oldPid)) {
        console.log(
          `[GS-HEARTBEAT] reaping orphaned process ${oldPid} (${pidFile})`,
        );
        killProcess(oldPid);
      }
    } catch {
      /* no stale pid file */
    }
  }
}

function writePid(file: string, pid: number): void {
  writeFileSync(file, String(pid));
}

function removePidFiles(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* not present */
  }
  try {
    unlinkSync(CHILD_PID_FILE);
  } catch {
    /* not present */
  }
}

function readLastTick(): number {
  try {
    return parseInt(readFileSync(LAST_TICK_FILE, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

let currentChild: ChildProcess | null = null;
let currentPoll: ReturnType<typeof setInterval> | null = null;

function launch(): void {
  cleanup();
  console.log(`[GS-HEARTBEAT] launching claude --model ${MODEL} ...`);

  const args = ["--model", MODEL, "--permission-mode", "auto"];
  if (SETTINGS_FILE) {
    args.push("--settings", SETTINGS_FILE);
  }
  if (SYSTEM_PROMPT_FILE) {
    args.push("--append-system-prompt-file", SYSTEM_PROMPT_FILE);
  }
  args.push(PROMPT);

  const child = spawn("claude", args, { stdio: "inherit", shell: true });
  currentChild = child;

  if (child.pid) {
    writePid(CHILD_PID_FILE, child.pid);
  }

  const poll = setInterval(() => {
    if (existsSync(RESTART_FLAG)) {
      cleanup();
      console.log(
        "[GS-HEARTBEAT] restart signal received — killing session for fresh context",
      );
      if (child.pid) killProcess(child.pid);
      return;
    }

    const lastTick = readLastTick();
    if (lastTick > 0) {
      const age = Date.now() - lastTick;
      if (age > WATCHDOG_TIMEOUT_MS) {
        console.log(
          `[GS-HEARTBEAT] watchdog: last tick was ${Math.round(age / 1000)}s ago ` +
            `(timeout ${WATCHDOG_TIMEOUT_MS / 1000}s) — killing stuck session`,
        );
        if (child.pid) killProcess(child.pid);
      }
    }
  }, 2000);
  currentPoll = poll;

  child.on("exit", (code) => {
    clearInterval(poll);
    currentChild = null;
    currentPoll = null;
    try {
      unlinkSync(CHILD_PID_FILE);
    } catch {
      /* not present */
    }
    console.log(
      `[GS-HEARTBEAT] session exited (code ${code}). restarting in 2s ...`,
    );
    setTimeout(launch, 2000);
  });
}

function shutdown(): void {
  console.log("\n[GS-HEARTBEAT] shutting down ...");
  if (currentPoll) clearInterval(currentPoll);
  if (currentChild?.pid) killProcess(currentChild.pid);
  removePidFiles();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (IS_WIN) {
  process.on("SIGHUP" as NodeJS.Signals, shutdown);
}

// --- startup ---
ensureIoDir();
reapOrphans();
writePid(PID_FILE, process.pid);

console.log("[GS-HEARTBEAT] starting supervisor");
console.log(`[GS-HEARTBEAT] io dir: ${IO_DIR}`);
console.log(`[GS-HEARTBEAT] watchdog timeout: ${WATCHDOG_TIMEOUT_MS / 1000}s`);
if (SETTINGS_FILE) {
  console.log(`[GS-HEARTBEAT] settings file: ${SETTINGS_FILE}`);
}
if (SYSTEM_PROMPT_FILE) {
  console.log(`[GS-HEARTBEAT] system prompt file: ${SYSTEM_PROMPT_FILE}`);
}
console.log("[GS-HEARTBEAT] press Ctrl+C to stop");

launch();
