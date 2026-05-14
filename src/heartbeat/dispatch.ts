#!/usr/bin/env bun
// GeneralStaff — heartbeat action dispatcher
//
// Called by the heartbeat agent (via Bash from its session) to act on an
// inbox message. Wraps the action so the agent doesn't have to format
// outbox JSON manually — this CLI writes structured start + complete
// entries to io/outbox.jsonl.
//
// Usage:
//   bun src/heartbeat/dispatch.ts run_cycle <project>
//   bun src/heartbeat/dispatch.ts run_session [--max-cycles=N]
//   bun src/heartbeat/dispatch.ts digest
//   bun src/heartbeat/dispatch.ts status
//   bun src/heartbeat/dispatch.ts manual <free-form instruction>
//
// run_session wraps `generalstaff session --max-cycles=1` by default,
// which fires GS's picker (one cycle on highest-priority project).
// Pass --max-cycles=N to run a chained session.
//
// The action vocabulary is documented in docs/HEARTBEAT.md. Unknown
// actions are logged but not executed (the agent should handle "manual"
// itself for free-form work).

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { $ } from "bun";
import type { HeartbeatAction, OutboxMessage } from "./types";

const IO_DIR = process.env.HEARTBEAT_IO_DIR
  ? resolve(process.env.HEARTBEAT_IO_DIR)
  : resolve(import.meta.dir, "..", "..", "io");

const OUTBOX = join(IO_DIR, "outbox.jsonl");

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function ensureIoDir(): void {
  if (!existsSync(IO_DIR)) {
    mkdirSync(IO_DIR, { recursive: true });
  }
}

function appendOutbox(msg: OutboxMessage): void {
  ensureIoDir();
  appendFileSync(OUTBOX, JSON.stringify(msg) + "\n");
}

function tailLines(s: string, n: number): string {
  const lines = s.trim().split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

function knownAction(s: string): HeartbeatAction | null {
  const known: HeartbeatAction[] = [
    "run_cycle",
    "run_session",
    "digest",
    "status",
    "manual",
  ];
  return known.includes(s as HeartbeatAction) ? (s as HeartbeatAction) : null;
}

async function runCycle(project: string): Promise<{ exit: number; summary: string }> {
  if (!project) {
    return { exit: 2, summary: "run_cycle requires a project id" };
  }
  // cli.ts `cycle` takes --project=<id>. Construct arg before interpolating so
  // bun's $ shell doesn't split "--project=" and the value into two tokens.
  const projectArg = `--project=${project}`;
  const proc =
    await $`bun src/cli.ts cycle ${projectArg}`.cwd(REPO_ROOT).nothrow().quiet();
  return {
    exit: proc.exitCode,
    summary: tailLines(proc.stdout.toString() + proc.stderr.toString(), 30),
  };
}

async function runSession(extraArgs: string[]): Promise<{ exit: number; summary: string }> {
  const hasMaxCycles = extraArgs.some((a) => a.startsWith("--max-cycles="));
  const args = hasMaxCycles ? extraArgs : ["--max-cycles=1", ...extraArgs];
  const proc =
    await $`bun src/cli.ts session ${args}`.cwd(REPO_ROOT).nothrow().quiet();
  return {
    exit: proc.exitCode,
    summary: tailLines(proc.stdout.toString() + proc.stderr.toString(), 30),
  };
}

async function runDigest(): Promise<{ exit: number; summary: string }> {
  const proc =
    await $`bun src/cli.ts digest`.cwd(REPO_ROOT).nothrow().quiet();
  return {
    exit: proc.exitCode,
    summary: tailLines(proc.stdout.toString() + proc.stderr.toString(), 30),
  };
}

async function runStatus(): Promise<{ exit: number; summary: string }> {
  const proc =
    await $`bun src/cli.ts status`.cwd(REPO_ROOT).nothrow().quiet();
  return {
    exit: proc.exitCode,
    summary: tailLines(proc.stdout.toString() + proc.stderr.toString(), 30),
  };
}

async function main(): Promise<void> {
  const [, , rawAction, ...rest] = process.argv;
  if (!rawAction) {
    console.error(
      "Usage: bun src/heartbeat/dispatch.ts <action> [args...]\n" +
        "Actions: run_cycle <project> | run_session [--max-cycles=N] | digest | status | manual <text>",
    );
    process.exit(2);
  }

  const action = knownAction(rawAction);
  const ts = new Date().toISOString();
  const startedAt = Date.now();

  if (!action) {
    appendOutbox({
      ts,
      action: "dispatch_unknown",
      summary: `Unknown action: ${rawAction}. Agent should treat as manual.`,
      exit: 2,
    });
    console.error(`Unknown action: ${rawAction}`);
    process.exit(2);
  }

  appendOutbox({
    ts,
    action: `${action}_start`,
    project: rest[0],
    summary: rest.join(" ") || undefined,
  });

  let exit = 0;
  let summary = "";

  try {
    switch (action) {
      case "run_cycle":
        ({ exit, summary } = await runCycle(rest[0] ?? ""));
        break;
      case "run_session":
        ({ exit, summary } = await runSession(rest));
        break;
      case "digest":
        ({ exit, summary } = await runDigest());
        break;
      case "status":
        ({ exit, summary } = await runStatus());
        break;
      case "manual":
        // Manual messages are handled by the agent itself; this CLI just
        // logs that the action was acknowledged.
        exit = 0;
        summary = "manual action acknowledged; agent handled inline.";
        break;
    }
  } catch (err) {
    exit = 1;
    summary = (err as Error).message ?? "unknown error";
  }

  const duration_sec = Math.round((Date.now() - startedAt) / 1000);

  appendOutbox({
    ts: new Date().toISOString(),
    action: `${action}_complete`,
    project: rest[0],
    exit,
    summary,
    duration_sec,
  });

  // Echo to stdout so the agent (and operator) sees the result inline.
  console.log(`[gs-heartbeat] ${action} -> exit=${exit} duration=${duration_sec}s`);
  if (summary) console.log(summary);

  process.exit(exit);
}

main();
