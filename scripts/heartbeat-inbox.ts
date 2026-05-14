#!/usr/bin/env bun
// GS heartbeat — inbox injector CLI
//
// Append a structured message to the heartbeat inbox. The supervisor's
// claude session will pick it up on the next Stop-hook fire.
//
// Usage:
//   bun scripts/heartbeat-inbox.ts run_cycle retrogaze
//   bun scripts/heartbeat-inbox.ts run_dispatch
//   bun scripts/heartbeat-inbox.ts digest
//   bun scripts/heartbeat-inbox.ts status
//   bun scripts/heartbeat-inbox.ts manual "Triage the daily-brief output and write a summary"
//
// You can also `echo '<raw line>' >> io/inbox.jsonl` directly — this
// CLI just provides a typed wrapper.

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import type { InboxMessage, HeartbeatAction } from "../src/heartbeat/types";

const IO_DIR = process.env.HEARTBEAT_IO_DIR
  ? resolve(process.env.HEARTBEAT_IO_DIR)
  : resolve(import.meta.dir, "..", "io");

const INBOX = join(IO_DIR, "inbox.jsonl");

function ensureIoDir(): void {
  if (!existsSync(IO_DIR)) {
    mkdirSync(IO_DIR, { recursive: true });
  }
}

function actionContent(action: HeartbeatAction, args: string[]): string {
  switch (action) {
    case "run_cycle":
      return `Run a GS cycle. Call: bun src/heartbeat/dispatch.ts run_cycle ${args[0] ?? ""}`;
    case "run_session":
      return `Run a GS session (picker mode). Call: bun src/heartbeat/dispatch.ts run_session ${args.join(" ")}`;
    case "digest":
      return "Generate a digest of recent activity. Call: bun src/heartbeat/dispatch.ts digest";
    case "status":
      return "Report fleet status. Call: bun src/heartbeat/dispatch.ts status";
    case "manual":
      return args.join(" ");
  }
}

function main(): void {
  const [, , rawAction, ...rest] = process.argv;
  if (!rawAction) {
    console.error(
      "Usage: bun scripts/heartbeat-inbox.ts <action> [args...]\n" +
        "Actions: run_cycle <project> | run_dispatch | digest | status | manual <text>",
    );
    process.exit(2);
  }

  const known: HeartbeatAction[] = [
    "run_cycle",
    "run_session",
    "digest",
    "status",
    "manual",
  ];
  if (!known.includes(rawAction as HeartbeatAction)) {
    console.error(`Unknown action: ${rawAction}. Use one of: ${known.join(", ")}`);
    process.exit(2);
  }
  const action = rawAction as HeartbeatAction;

  const msg: InboxMessage = {
    ts: new Date().toISOString(),
    channel: "cli",
    author: process.env.USER ?? process.env.USERNAME ?? "operator",
    action,
    project: action === "run_cycle" ? rest[0] : undefined,
    content: actionContent(action, rest),
  };

  ensureIoDir();
  appendFileSync(INBOX, JSON.stringify(msg) + "\n");
  console.log(`[gs-heartbeat] queued: ${msg.action} ${msg.project ?? ""}`);
}

main();
