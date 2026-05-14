#!/usr/bin/env bun
// GeneralStaff — heartbeat Stop hook
//
// Port of upstream claude-heartbeat hooks/heartbeat.js with GS conventions.
// Runs as the Stop hook configured in scripts/heartbeat-settings.json.
//
// Behavior:
//   - Idle: blocks with minimal IDLE_TICK, session stays alive
//   - Message: blocks with formatted message, sets .responded flag
//   - After response: sees .responded, sets .restart flag, blocks IDLE_TICK
//     to keep claude alive until the supervisor kills it for fresh context
//
// Env:
//   HEARTBEAT_INTERVAL — minimum seconds between idle ticks (default: 60)
//   HEARTBEAT_IO_DIR   — override io/ directory (default: <repo>/io)

import { existsSync, openSync, readSync, writeSync, fsyncSync, closeSync, statSync, unlinkSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import type { InboxMessage, HookDecision } from "./types";

const IS_WIN = process.platform === "win32";
const IO_DIR = process.env.HEARTBEAT_IO_DIR
  ? resolve(process.env.HEARTBEAT_IO_DIR)
  : resolve(import.meta.dir, "..", "..", "io");

const INBOX = join(IO_DIR, "inbox.jsonl");
const OFFSET_FILE = join(IO_DIR, ".inbox-offset");
const LAST_TICK_FILE = join(IO_DIR, ".last-tick");
const RESPONDED_FLAG = join(IO_DIR, ".responded");
const RESTART_FLAG = join(IO_DIR, ".restart");

const MIN_INTERVAL_SEC = parseInt(process.env.HEARTBEAT_INTERVAL ?? "60", 10);
const MIN_INTERVAL_MS = MIN_INTERVAL_SEC * 1000;
const IDLE_TICK = "--- TURN START ---\n--- TURN END ---";

function block(reason: string): never {
  const decision: HookDecision = { decision: "block", reason };
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

function readOffset(): number {
  try {
    return parseInt(readFileSync(OFFSET_FILE, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeSyncFile(filepath: string, data: string): void {
  const fd = openSync(filepath, "w");
  writeSync(fd, data);
  fsyncSync(fd);
  closeSync(fd);
}

function writeOffset(n: number): void {
  writeSyncFile(OFFSET_FILE, String(n));
}

function readLastTick(): number {
  try {
    return parseInt(readFileSync(LAST_TICK_FILE, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeLastTick(): void {
  writeSyncFile(LAST_TICK_FILE, String(Date.now()));
}

function checkInbox(): InboxMessage | null {
  try {
    if (!existsSync(INBOX)) return null;
    const size = statSync(INBOX).size;
    const offset = readOffset();
    if (size <= offset) return null;

    const buf = Buffer.alloc(size - offset);
    const fd = openSync(INBOX, "r");
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);

    const raw = buf.toString("utf8");
    const nlIndex = raw.indexOf("\n");
    const line = nlIndex === -1 ? raw : raw.slice(0, nlIndex);
    if (!line.trim()) return null;

    // Advance offset by exactly this one line (+ newline if present)
    writeOffset(offset + Buffer.byteLength(line, "utf8") + (nlIndex === -1 ? 0 : 1));

    try {
      return JSON.parse(line) as InboxMessage;
    } catch {
      return {
        ts: new Date().toISOString(),
        channel: "inbox",
        author: "user",
        content: line.trim(),
      };
    }
  } catch {
    return null;
  }
}

function formatMessage(m: InboxMessage): string {
  const time = m.ts
    ? new Date(m.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const channel = m.channel ?? "unknown";
  const author = m.author ?? "system";
  const content = m.content ?? "";
  // Embed action+project hints as a small header the agent can parse.
  const meta: string[] = [];
  if (m.action) meta.push(`action=${m.action}`);
  if (m.project) meta.push(`project=${m.project}`);
  const metaLine = meta.length ? `\n[gs-heartbeat ${meta.join(" ")}]` : "";
  return `[${time}] #${channel} ${author}: ${content}${metaLine}`;
}

function sleepSecs(secs: number): void {
  try {
    if (IS_WIN) {
      execSync(`ping -n ${secs + 1} 127.0.0.1 > nul`, {
        timeout: (secs + 5) * 1000,
        windowsHide: true,
      });
    } else {
      execSync(`sleep ${secs}`, { timeout: (secs + 5) * 1000 });
    }
  } catch {
    /* ignore */
  }
}

// --- main ---

// 0. Did the agent just respond to a real message? Signal restart for fresh
//    context, but first check if another message is queued (process it before
//    restarting so we don't waste a restart cycle on an empty queue).
if (existsSync(RESPONDED_FLAG)) {
  unlinkSync(RESPONDED_FLAG);
  const next = checkInbox();
  if (next) {
    writeSyncFile(RESPONDED_FLAG, "");
    block(formatMessage(next));
  }
  writeSyncFile(RESTART_FLAG, "");
  block(IDLE_TICK);
}

// 1. Immediate inbox check — deliver one message if present
const msg = checkInbox();
if (msg) {
  writeLastTick();
  writeSyncFile(RESPONDED_FLAG, "");
  block(formatMessage(msg));
}

// 2. No messages — check throttle
const elapsed = Date.now() - readLastTick();
if (elapsed < MIN_INTERVAL_MS) {
  sleepSecs(15);

  const retryMsg = checkInbox();
  if (retryMsg) {
    writeLastTick();
    writeSyncFile(RESPONDED_FLAG, "");
    block(formatMessage(retryMsg));
  }

  block(IDLE_TICK);
}

// 3. Interval elapsed — send idle tick
writeLastTick();
block(IDLE_TICK);
