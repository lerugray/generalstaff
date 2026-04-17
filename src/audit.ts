// GeneralStaff — audit writer (build step 7)
// Append-only PROGRESS.jsonl per project (Hard Rule #9)

import { existsSync, mkdirSync } from "fs";
import { appendFile, readFile } from "fs/promises";
import { join, dirname } from "path";
import { getRootDir } from "./state";
import { isProgressEntry, type ProgressEntry, type ProgressEventType } from "./types";
import { formatDuration } from "./format";

export interface CycleHistoryRow {
  cycle_id: string;
  project: string;
  outcome: string;
  duration: string;
  sha_range: string;
  timestamp: string;
}

function progressPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "PROGRESS.jsonl");
}

export async function appendProgress(
  projectId: string,
  event: ProgressEventType,
  data: Record<string, unknown>,
  cycleId?: string,
) {
  const entry: ProgressEntry = {
    timestamp: new Date().toISOString(),
    event,
    cycle_id: cycleId,
    project_id: projectId,
    data,
  };

  const filePath = progressPath(projectId);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export type LogLevel = "error";

export interface TailProgressOptions {
  level?: LogLevel;
}

export function isErrorEntry(entry: ProgressEntry): boolean {
  if (entry.event === "cycle_skipped") return true;
  if (entry.event.endsWith("_error")) return true;
  if (entry.data?.outcome === "verification_failed") return true;
  return false;
}

export async function tailProgressLog(
  projectId: string | undefined,
  lines: number = 20,
  options: TailProgressOptions = {},
) {
  if (projectId) {
    await tailSingleProject(projectId, lines, options);
  } else {
    // Show across all projects
    const stateDir = join(getRootDir(), "state");
    if (!existsSync(stateDir)) {
      console.log("No state directory found. No cycles have run yet.");
      return;
    }

    const entries: ProgressEntry[] = [];
    const { readdirSync } = require("fs");
    for (const dir of readdirSync(stateDir)) {
      const filePath = join(stateDir, dir, "PROGRESS.jsonl");
      if (!existsSync(filePath)) continue;
      const content = await readFile(filePath, "utf8");
      for (const line of content.trim().split("\n")) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            if (isProgressEntry(parsed)) {
              entries.push(parsed);
            }
          } catch {
            // skip malformed
          }
        }
      }
    }

    entries.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const filtered =
      options.level === "error" ? entries.filter(isErrorEntry) : entries;
    const tail = filtered.slice(-lines);
    for (const entry of tail) {
      printEntry(entry);
    }

    if (entries.length === 0) {
      console.log("No audit log entries found.");
    } else if (filtered.length === 0 && options.level === "error") {
      console.log("No error-level audit log entries found.");
    }
  }
}

async function tailSingleProject(
  projectId: string,
  lines: number,
  options: TailProgressOptions = {},
) {
  const filePath = progressPath(projectId);
  if (!existsSync(filePath)) {
    console.log(`No PROGRESS.jsonl for project "${projectId}".`);
    return;
  }

  const content = await readFile(filePath, "utf8");
  const allLines = content.trim().split("\n").filter(Boolean);

  if (options.level === "error") {
    const matches: string[] = [];
    for (const line of allLines) {
      try {
        const parsed = JSON.parse(line);
        if (isProgressEntry(parsed) && isErrorEntry(parsed)) {
          matches.push(line);
        }
      } catch {
        // skip malformed
      }
    }
    const tail = matches.slice(-lines);
    for (const line of tail) {
      const parsed = JSON.parse(line);
      if (isProgressEntry(parsed)) printEntry(parsed);
    }
    if (matches.length === 0) {
      console.log(`No error-level entries for project "${projectId}".`);
    }
    return;
  }

  const tail = allLines.slice(-lines);
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line);
      if (isProgressEntry(parsed)) {
        printEntry(parsed);
      } else {
        console.log(line);
      }
    } catch {
      console.log(line);
    }
  }
}

function printEntry(entry: ProgressEntry) {
  const ts = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const project = entry.project_id ?? "?";
  const cycle = entry.cycle_id ? ` [${entry.cycle_id.slice(0, 8)}]` : "";
  const summary = formatData(entry.event, entry.data);
  console.log(`${ts}  ${project}${cycle}  ${entry.event}  ${summary}`);
}

function formatData(
  event: ProgressEventType,
  data: Record<string, unknown>,
): string {
  switch (event) {
    case "cycle_start":
      return `sha=${(data.start_sha as string)?.slice(0, 8) ?? "?"}`;
    case "cycle_end":
      return `outcome=${data.outcome ?? "?"}  reason=${data.reason ?? ""}`;
    case "engineer_completed":
      return `exit=${data.exit_code ?? "?"}  duration=${data.duration_seconds ?? "?"}s`;
    case "verification_outcome":
      return `result=${data.outcome ?? "?"}  exit=${data.exit_code ?? "?"}`;
    case "reviewer_verdict":
      return `verdict=${data.verdict ?? "?"}  reason=${data.reason ?? ""}`;
    case "cycle_skipped":
      return `reason=${data.reason ?? "?"}`;
    default:
      return JSON.stringify(data).slice(0, 100);
  }
}

function shaRange(startSha: unknown, endSha: unknown): string {
  const start = typeof startSha === "string" ? startSha.slice(0, 7) : "?";
  const end = typeof endSha === "string" ? endSha.slice(0, 7) : "?";
  return start === end ? start : `${start}..${end}`;
}

export interface LoadCycleHistoryOptions {
  since?: string;
  until?: string;
}

// Parse a YYYYMMDD string to an epoch-ms bound. endOfDay=true returns the
// inclusive end of that UTC day (last ms). Throws on malformed input.
export function parseDateFlag(input: string, endOfDay: boolean): number {
  if (!/^\d{8}$/.test(input)) {
    throw new Error(
      `Invalid date '${input}': expected YYYYMMDD (e.g. 20260415)`,
    );
  }
  const year = parseInt(input.slice(0, 4), 10);
  const month = parseInt(input.slice(4, 6), 10);
  const day = parseInt(input.slice(6, 8), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(
      `Invalid date '${input}': month and day must be in range`,
    );
  }
  const ms = endOfDay
    ? Date.UTC(year, month - 1, day, 23, 59, 59, 999)
    : Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date '${input}': not a real calendar date`);
  }
  return ms;
}

function startedAtMs(entry: ProgressEntry): number {
  const endMs = new Date(entry.timestamp).getTime();
  const dur = entry.data.duration_seconds;
  return typeof dur === "number" ? endMs - dur * 1000 : endMs;
}

export async function loadCycleHistory(
  projectId: string | undefined,
  limit: number = 20,
  options: LoadCycleHistoryOptions = {},
): Promise<CycleHistoryRow[]> {
  const sinceMs = options.since !== undefined
    ? parseDateFlag(options.since, false)
    : undefined;
  const untilMs = options.until !== undefined
    ? parseDateFlag(options.until, true)
    : undefined;

  const stateDir = join(getRootDir(), "state");
  if (!existsSync(stateDir)) return [];

  const entries: ProgressEntry[] = [];
  const { readdirSync } = require("fs");

  const collect = (content: string) => {
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (isProgressEntry(parsed) && parsed.event === "cycle_end") {
          const started = startedAtMs(parsed);
          if (sinceMs !== undefined && started < sinceMs) continue;
          if (untilMs !== undefined && started > untilMs) continue;
          entries.push(parsed);
        }
      } catch { /* skip malformed */ }
    }
  };

  if (projectId) {
    const filePath = join(stateDir, projectId, "PROGRESS.jsonl");
    if (!existsSync(filePath)) return [];
    collect(await readFile(filePath, "utf8"));
  } else {
    for (const dir of readdirSync(stateDir)) {
      const filePath = join(stateDir, dir, "PROGRESS.jsonl");
      if (!existsSync(filePath)) continue;
      collect(await readFile(filePath, "utf8"));
    }
  }

  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return entries.slice(-limit).map((e) => ({
    cycle_id: (e.cycle_id ?? "?").slice(0, 12),
    project: e.project_id ?? "?",
    outcome: String(e.data.outcome ?? "?"),
    duration: typeof e.data.duration_seconds === "number"
      ? formatDuration(e.data.duration_seconds)
      : "?",
    sha_range: shaRange(e.data.start_sha, e.data.end_sha),
    timestamp: e.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z"),
  }));
}

const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
} as const;

export function colorizeOutcome(outcome: string, useColor: boolean): string {
  if (!useColor) return outcome;
  switch (outcome) {
    case "verified":
      return `${ANSI.green}${outcome}${ANSI.reset}`;
    case "verification_failed":
      return `${ANSI.red}${outcome}${ANSI.reset}`;
    case "verified_weak":
      return `${ANSI.yellow}${outcome}${ANSI.reset}`;
    case "cycle_skipped":
      return `${ANSI.gray}${outcome}${ANSI.reset}`;
    default:
      return outcome;
  }
}

export function printHistoryTable(
  rows: CycleHistoryRow[],
  useColor: boolean = Boolean(process.stdout.isTTY),
): void {
  if (rows.length === 0) {
    console.log("No cycle history found.");
    return;
  }

  // Column widths — compute dynamically from data
  const headers = { cycle_id: "CYCLE", project: "PROJECT", outcome: "OUTCOME", duration: "DURATION", sha_range: "SHA RANGE", timestamp: "TIMESTAMP" } as const;
  const keys = ["cycle_id", "project", "outcome", "duration", "sha_range", "timestamp"] as const;

  const widths: Record<string, number> = {};
  for (const k of keys) {
    widths[k] = Math.max(headers[k].length, ...rows.map((r) => r[k].length));
  }

  const pad = (s: string, w: number) => s.padEnd(w);
  const headerLine = keys.map((k) => pad(headers[k], widths[k])).join("  ");
  const separator = keys.map((k) => "-".repeat(widths[k])).join("  ");

  console.log(headerLine);
  console.log(separator);
  for (const row of rows) {
    // Pad first using raw text so column widths stay correct, then colorize the outcome cell.
    const cells = keys.map((k) => {
      const padded = pad(row[k], widths[k]);
      if (k === "outcome" && useColor) {
        const colored = colorizeOutcome(row[k], true);
        return padded.replace(row[k], colored);
      }
      return padded;
    });
    console.log(cells.join("  "));
  }
}

export function printHistoryCompact(
  rows: CycleHistoryRow[],
  useColor: boolean = Boolean(process.stdout.isTTY),
  costs?: Record<string, CycleCostSummary>,
): void {
  for (const row of rows) {
    const outcome = colorizeOutcome(row.outcome, useColor);
    const base = `${row.timestamp}\t${row.project}\t${row.cycle_id}\t${outcome}\t${row.duration}\t${row.sha_range}`;
    if (costs) {
      const c = costs[row.cycle_id];
      const invocations = c?.reviewer_invocations ?? 0;
      const tokens = c?.estimated_tokens ?? 0;
      console.log(`${base}\t${invocations}\t${tokens}`);
    } else {
      console.log(base);
    }
  }
}

// --- Cost summarization (reviewer_invoked token estimates) ---

// Rough heuristic: 1 token ≈ 4 characters of prompt text. This is Anthropic's
// published ballpark for English; good enough for a "how expensive is this
// project getting" signal without pretending to be exact.
const CHARS_PER_TOKEN = 4;

export interface CycleCostSummary {
  cycle_id: string;
  reviewer_invocations: number;
  prompt_chars: number;
  estimated_tokens: number;
}

export interface CostsSummary {
  reviewer_invocations: number;
  prompt_chars: number;
  estimated_tokens: number;
  by_cycle: Record<string, CycleCostSummary>;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

async function readReviewerInvoked(filePath: string): Promise<ProgressEntry[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  const out: ProgressEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isProgressEntry(parsed) && parsed.event === "reviewer_invoked") {
        out.push(parsed);
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

// Keyed by the same 12-char cycle_id prefix used in CycleHistoryRow so the
// map can be handed straight to printHistoryCompact without re-keying.
export async function summarizeCosts(
  projectId?: string,
): Promise<CostsSummary> {
  const stateDir = join(getRootDir(), "state");
  if (!existsSync(stateDir)) {
    return { reviewer_invocations: 0, prompt_chars: 0, estimated_tokens: 0, by_cycle: {} };
  }

  const { readdirSync } = require("fs");
  const entries: ProgressEntry[] = [];

  if (projectId) {
    entries.push(...(await readReviewerInvoked(join(stateDir, projectId, "PROGRESS.jsonl"))));
  } else {
    for (const dir of readdirSync(stateDir)) {
      entries.push(...(await readReviewerInvoked(join(stateDir, dir, "PROGRESS.jsonl"))));
    }
  }

  const byCycle: Record<string, CycleCostSummary> = {};
  let totalChars = 0;

  for (const e of entries) {
    const fullId = e.cycle_id ?? "?";
    const key = fullId.slice(0, 12);
    const rawLen = e.data.prompt_length;
    const chars = typeof rawLen === "number" && rawLen >= 0 ? rawLen : 0;
    totalChars += chars;

    const existing = byCycle[key];
    if (existing) {
      existing.reviewer_invocations += 1;
      existing.prompt_chars += chars;
      existing.estimated_tokens = estimateTokens(existing.prompt_chars);
    } else {
      byCycle[key] = {
        cycle_id: key,
        reviewer_invocations: 1,
        prompt_chars: chars,
        estimated_tokens: estimateTokens(chars),
      };
    }
  }

  return {
    reviewer_invocations: entries.length,
    prompt_chars: totalChars,
    estimated_tokens: estimateTokens(totalChars),
    by_cycle: byCycle,
  };
}
