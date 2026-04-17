// GeneralStaff — recent-session summary for `generalstaff status --sessions`
// (gs-127). Reads session_complete events from the _fleet PROGRESS.jsonl and
// renders them as a table.

import { join } from "path";
import { getRootDir } from "./state";
import { readJsonl } from "./audit";
import { isProgressEntry } from "./types";
import { formatDuration, formatRelativeTime } from "./format";

export interface SessionSummary {
  started_at: string;
  duration_minutes: number;
  total_cycles: number;
  total_verified: number;
  total_failed: number;
  stop_reason: string;
  reviewer: string;
}

function asString(v: unknown, fallback = "-"): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Read session_complete events from the _fleet log and return the most recent
// N entries, newest first. Missing file or no matching events yields [].
export async function loadRecentSessions(
  limit: number,
  fleetLogPath?: string,
): Promise<SessionSummary[]> {
  const path =
    fleetLogPath ?? join(getRootDir(), "state", "_fleet", "PROGRESS.jsonl");
  const parsed = await readJsonl(path);
  const sessions: SessionSummary[] = [];
  for (const value of parsed) {
    if (!isProgressEntry(value)) continue;
    if (value.event !== "session_complete") continue;
    const d = value.data;
    // duration_minutes came out of the session_complete writer so trust it,
    // but guard against a malformed historical line.
    const durationMin = asNumber(d.duration_minutes);
    const startedAtMs =
      new Date(value.timestamp).getTime() - durationMin * 60_000;
    sessions.push({
      started_at: new Date(startedAtMs).toISOString(),
      duration_minutes: durationMin,
      total_cycles: asNumber(d.total_cycles),
      total_verified: asNumber(d.total_verified),
      total_failed: asNumber(d.total_failed),
      stop_reason: asString(d.stop_reason, "-"),
      reviewer: asString(d.reviewer, "-"),
    });
  }
  sessions.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return sessions.slice(0, limit);
}

export interface ParsedSessionsFlag {
  enabled: boolean;
  limit: number;
}

const DEFAULT_SESSIONS_LIMIT = 10;

// Parse `--sessions` / `--sessions=N` from raw argv tail. Mirrors
// parseWatchFlag so the status command can mix both flags cleanly.
export function parseSessionsFlag(rawArgs: string[]): ParsedSessionsFlag {
  let enabled = false;
  let limit = DEFAULT_SESSIONS_LIMIT;
  for (const arg of rawArgs) {
    if (arg === "--sessions") {
      enabled = true;
    } else if (arg.startsWith("--sessions=")) {
      enabled = true;
      const raw = arg.slice("--sessions=".length);
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    }
  }
  return { enabled, limit };
}

export function stripSessionsArgs(rawArgs: string[]): string[] {
  return rawArgs.filter(
    (a) => a !== "--sessions" && !a.startsWith("--sessions="),
  );
}

export function formatSessionsTable(
  sessions: SessionSummary[],
  now: Date = new Date(),
): string {
  if (sessions.length === 0) {
    return "No sessions recorded yet.";
  }
  const rows = sessions.map((s) => {
    const pass = `${s.total_verified}/${s.total_cycles}`;
    return [
      formatRelativeTime(s.started_at, now),
      formatDuration(s.duration_minutes * 60),
      `${s.total_cycles} cycle${s.total_cycles === 1 ? "" : "s"}`,
      `${pass} verified`,
      s.reviewer,
      s.stop_reason,
    ];
  });
  const header = [
    "Started",
    "Duration",
    "Cycles",
    "Pass",
    "Reviewer",
    "Stop reason",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const lines = [pad(header), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) lines.push(pad(r));
  return lines.join("\n");
}
