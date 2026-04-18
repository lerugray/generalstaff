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
  // gs-188: optional parallel-mode metrics. Only set when the session
  // ran with dispatcher.max_parallel_slots > 1. Sequential sessions
  // leave these undefined so the sessions table degrades gracefully
  // for pre-gs-186 history.
  max_parallel_slots?: number;
  parallel_rounds?: number;
  slot_idle_seconds?: number;
  parallel_efficiency?: number;
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
    const summary: SessionSummary = {
      started_at: new Date(startedAtMs).toISOString(),
      duration_minutes: durationMin,
      total_cycles: asNumber(d.total_cycles),
      total_verified: asNumber(d.total_verified),
      total_failed: asNumber(d.total_failed),
      stop_reason: asString(d.stop_reason, "-"),
      reviewer: asString(d.reviewer, "-"),
    };
    // gs-188: lift parallel metrics when present. `> 1` guard filters
    // out legacy sessions that pre-dated gs-186 without the field, as
    // well as explicit sequential sessions that emit max_parallel_slots
    // = 1.
    if (typeof d.max_parallel_slots === "number" && d.max_parallel_slots > 1) {
      summary.max_parallel_slots = d.max_parallel_slots;
      summary.parallel_rounds = asNumber(d.parallel_rounds);
      summary.slot_idle_seconds = asNumber(d.slot_idle_seconds);
      if (typeof d.parallel_efficiency === "number") {
        summary.parallel_efficiency = d.parallel_efficiency;
      }
    }
    sessions.push(summary);
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

// gs-199: backlog subview. One row per project with the four
// pending-bucket counts plus in_progress + done. Data shape mirrors
// WorkBreakdown from src/work_detection.ts but flattened and renamed
// for stable CLI/JSON output.
export interface BacklogRow {
  project_id: string;
  bot_pickable: number;
  interactive_only: number;
  handsoff_conflict: number;
  in_progress: number;
  done: number;
}

export interface BacklogTotals {
  bot_pickable: number;
  interactive_only: number;
  handsoff_conflict: number;
  in_progress: number;
}

export function computeBacklogTotals(rows: BacklogRow[]): BacklogTotals {
  const t: BacklogTotals = {
    bot_pickable: 0,
    interactive_only: 0,
    handsoff_conflict: 0,
    in_progress: 0,
  };
  for (const r of rows) {
    t.bot_pickable += r.bot_pickable;
    t.interactive_only += r.interactive_only;
    t.handsoff_conflict += r.handsoff_conflict;
    t.in_progress += r.in_progress;
  }
  return t;
}

export function formatBacklogTable(rows: BacklogRow[]): string {
  if (rows.length === 0) {
    return "No projects registered.";
  }
  const header = [
    "Project",
    "Bot-pickable",
    "Interactive-only",
    "Hands-off-conflict",
    "In-progress",
    "Done",
  ];
  const body: string[][] = rows.map((r) => [
    r.project_id,
    String(r.bot_pickable),
    String(r.interactive_only),
    String(r.handsoff_conflict),
    String(r.in_progress),
    String(r.done),
  ]);
  const totals = computeBacklogTotals(rows);
  const totalDone = rows.reduce((a, r) => a + r.done, 0);
  body.push([
    "TOTAL",
    String(totals.bot_pickable),
    String(totals.interactive_only),
    String(totals.handsoff_conflict),
    String(totals.in_progress),
    String(totalDone),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]!.length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const lines = [pad(header), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of body) lines.push(pad(r));
  return lines.join("\n");
}

// gs-202: aggregate totals across the full session history for
// `generalstaff status --totals`. Summarises cycle throughput, time
// spent, parallel-vs-sequential mix, and a duration-weighted average
// efficiency for the parallel runs.
export interface SessionTotals {
  total_sessions: number;
  total_cycles: number;
  total_verified: number;
  total_failed: number;
  total_duration_hours: number;
  parallel_sessions: number;
  sequential_sessions: number;
  weighted_avg_parallel_efficiency: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export function computeSessionTotals(sessions: SessionSummary[]): SessionTotals {
  if (sessions.length === 0) {
    return {
      total_sessions: 0,
      total_cycles: 0,
      total_verified: 0,
      total_failed: 0,
      total_duration_hours: 0,
      parallel_sessions: 0,
      sequential_sessions: 0,
      weighted_avg_parallel_efficiency: null,
      first_seen: null,
      last_seen: null,
    };
  }
  let total_cycles = 0;
  let total_verified = 0;
  let total_failed = 0;
  let total_duration_min = 0;
  let parallel_sessions = 0;
  let sequential_sessions = 0;
  let weighted_eff_num = 0;
  let weighted_eff_den = 0;
  let first_seen_ms = Infinity;
  let last_seen_ms = -Infinity;
  for (const s of sessions) {
    total_cycles += s.total_cycles;
    total_verified += s.total_verified;
    total_failed += s.total_failed;
    total_duration_min += s.duration_minutes;
    const isParallel =
      typeof s.max_parallel_slots === "number" && s.max_parallel_slots > 1;
    if (isParallel) {
      parallel_sessions += 1;
      if (typeof s.parallel_efficiency === "number") {
        weighted_eff_num += s.parallel_efficiency * s.duration_minutes;
        weighted_eff_den += s.duration_minutes;
      }
    } else {
      sequential_sessions += 1;
    }
    const ms = new Date(s.started_at).getTime();
    if (Number.isFinite(ms)) {
      if (ms < first_seen_ms) first_seen_ms = ms;
      if (ms > last_seen_ms) last_seen_ms = ms;
    }
  }
  return {
    total_sessions: sessions.length,
    total_cycles,
    total_verified,
    total_failed,
    total_duration_hours: total_duration_min / 60,
    parallel_sessions,
    sequential_sessions,
    weighted_avg_parallel_efficiency:
      weighted_eff_den > 0 ? weighted_eff_num / weighted_eff_den : null,
    first_seen:
      first_seen_ms === Infinity ? null : new Date(first_seen_ms).toISOString(),
    last_seen:
      last_seen_ms === -Infinity ? null : new Date(last_seen_ms).toISOString(),
  };
}

export function formatSessionTotals(t: SessionTotals): string {
  if (t.total_sessions === 0) {
    return "No sessions recorded yet.";
  }
  const eff =
    t.weighted_avg_parallel_efficiency !== null
      ? `${(t.weighted_avg_parallel_efficiency * 100).toFixed(1)}%`
      : "—";
  const lines = [
    `Total sessions:                   ${t.total_sessions}`,
    `Total cycles:                     ${t.total_cycles}`,
    `Total verified:                   ${t.total_verified}`,
    `Total failed:                     ${t.total_failed}`,
    `Total duration:                   ${t.total_duration_hours.toFixed(2)} hours`,
    `Parallel sessions:                ${t.parallel_sessions}`,
    `Sequential sessions:              ${t.sequential_sessions}`,
    `Weighted-avg parallel efficiency: ${eff}`,
    `First seen:                       ${t.first_seen ?? "—"}`,
    `Last seen:                        ${t.last_seen ?? "—"}`,
  ];
  return lines.join("\n");
}

export function formatSessionsTable(
  sessions: SessionSummary[],
  now: Date = new Date(),
): string {
  if (sessions.length === 0) {
    return "No sessions recorded yet.";
  }
  // gs-188: only add the Parallel column when at least one session in
  // the window actually used parallel mode — sequential-only tables
  // stay identical to the pre-gs-188 layout.
  const anyParallel = sessions.some(
    (s) => typeof s.max_parallel_slots === "number" && s.max_parallel_slots > 1,
  );
  const rows = sessions.map((s) => {
    const pass = `${s.total_verified}/${s.total_cycles}`;
    const base = [
      formatRelativeTime(s.started_at, now),
      formatDuration(s.duration_minutes * 60),
      `${s.total_cycles} cycle${s.total_cycles === 1 ? "" : "s"}`,
      `${pass} verified`,
      s.reviewer,
      s.stop_reason,
    ];
    if (anyParallel) {
      const slots = s.max_parallel_slots;
      const cell =
        typeof slots === "number" && slots > 1
          ? typeof s.parallel_efficiency === "number"
            ? `${slots}× @ ${(s.parallel_efficiency * 100).toFixed(0)}%`
            : `${slots}×`
          : "—";
      base.push(cell);
    }
    return base;
  });
  const header = [
    "Started",
    "Duration",
    "Cycles",
    "Pass",
    "Reviewer",
    "Stop reason",
  ];
  if (anyParallel) header.push("Parallel");
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const lines = [pad(header), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) lines.push(pad(r));
  return lines.join("\n");
}
