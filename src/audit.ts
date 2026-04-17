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

// Read a newline-delimited JSON file and return parsed values. Missing file
// returns []. Blank lines and malformed lines are silently skipped — callers
// that need to preserve raw lines (e.g. `log` output) should do their own
// parsing instead.
export async function readJsonl(path: string): Promise<unknown[]> {
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf8");
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return out;
}

// Module-level verbose toggle. Enabled by `generalstaff session --verbose`
// (via setVerboseMode). When on, every appended PROGRESS.jsonl entry also
// prints a one-line summary to stdout so long-running sessions are
// observable in real time.
let verboseMode = false;

export function setVerboseMode(on: boolean): void {
  verboseMode = on;
}

export function isVerboseMode(): boolean {
  return verboseMode;
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

  if (verboseMode) {
    printEntry(entry);
  }
}

export type LogLevel = "error";

export interface TailProgressOptions {
  level?: LogLevel;
  grep?: RegExp;
  sinceMs?: number;
}

// Parse a --since flag value. Accepts relative durations (30s, 15m, 2h, 3d)
// or an absolute ISO-8601 timestamp. Returns the resulting epoch-ms lower
// bound. `now` is injected for deterministic testing.
export function parseSinceFlag(input: string, now: Date = new Date()): number {
  const relMatch = /^(\d+)([smhd])$/.exec(input.trim());
  if (relMatch) {
    const amount = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!;
    const multiplier =
      unit === "s" ? 1000 :
      unit === "m" ? 60 * 1000 :
      unit === "h" ? 60 * 60 * 1000 :
      24 * 60 * 60 * 1000;
    return now.getTime() - amount * multiplier;
  }
  const ts = Date.parse(input);
  if (Number.isNaN(ts)) {
    throw new Error(
      `Invalid --since value '${input}': expected ISO timestamp or relative duration (e.g. 30m, 2h, 1d)`,
    );
  }
  return ts;
}

function matchesSince(entry: ProgressEntry, sinceMs: number): boolean {
  const t = Date.parse(entry.timestamp);
  return !Number.isNaN(t) && t >= sinceMs;
}

export function isErrorEntry(entry: ProgressEntry): boolean {
  if (entry.event === "cycle_skipped") return true;
  if (entry.event.endsWith("_error")) return true;
  if (entry.data?.outcome === "verification_failed") return true;
  return false;
}

// Compile a user-supplied regex string with the case-insensitive flag. Throws a
// clear Error on invalid syntax so callers can surface a single-line message
// instead of the raw engine output.
export function compileGrepPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(
      `Invalid --grep pattern '${pattern}': ${(err as Error).message}`,
    );
  }
}

export function matchesGrep(entry: ProgressEntry, pattern: RegExp): boolean {
  const haystack = `${entry.event} ${JSON.stringify(entry.data ?? {})}`;
  return pattern.test(haystack);
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
      for (const value of await readJsonl(join(stateDir, dir, "PROGRESS.jsonl"))) {
        if (isProgressEntry(value)) entries.push(value);
      }
    }

    entries.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    let filtered = entries;
    if (options.level === "error") filtered = filtered.filter(isErrorEntry);
    if (options.grep) {
      const re = options.grep;
      filtered = filtered.filter((e) => matchesGrep(e, re));
    }
    if (options.sinceMs !== undefined) {
      const since = options.sinceMs;
      filtered = filtered.filter((e) => matchesSince(e, since));
    }
    const tail = filtered.slice(-lines);
    for (const entry of tail) {
      printEntry(entry);
    }

    if (entries.length === 0) {
      console.log("No audit log entries found.");
    } else if (filtered.length === 0) {
      if (options.grep && options.level === "error") {
        console.log("No error-level audit log entries matching grep pattern.");
      } else if (options.grep) {
        console.log("No audit log entries matching grep pattern.");
      } else if (options.level === "error") {
        console.log("No error-level audit log entries found.");
      } else if (options.sinceMs !== undefined) {
        console.log("No audit log entries since the given time.");
      }
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

  if (options.level === "error" || options.grep || options.sinceMs !== undefined) {
    const matches: string[] = [];
    for (const line of allLines) {
      try {
        const parsed = JSON.parse(line);
        if (!isProgressEntry(parsed)) continue;
        if (options.level === "error" && !isErrorEntry(parsed)) continue;
        if (options.grep && !matchesGrep(parsed, options.grep)) continue;
        if (options.sinceMs !== undefined && !matchesSince(parsed, options.sinceMs)) continue;
        matches.push(line);
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
      if (options.grep && options.level === "error") {
        console.log(
          `No error-level entries matching grep pattern for project "${projectId}".`,
        );
      } else if (options.grep) {
        console.log(
          `No entries matching grep pattern for project "${projectId}".`,
        );
      } else if (options.level === "error") {
        console.log(`No error-level entries for project "${projectId}".`);
      } else if (options.sinceMs !== undefined) {
        console.log(`No entries since the given time for project "${projectId}".`);
      }
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

export const VALID_OUTCOME_FILTERS = [
  "verified",
  "verified_weak",
  "verification_failed",
  "cycle_skipped",
] as const;
export type OutcomeFilter = (typeof VALID_OUTCOME_FILTERS)[number];

export interface LoadCycleHistoryOptions {
  since?: string;
  until?: string;
  verifiedOnly?: boolean;
  outcome?: OutcomeFilter;
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

async function collectCycleEnds(
  projectId: string | undefined,
  options: LoadCycleHistoryOptions,
): Promise<ProgressEntry[]> {
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

  const collect = async (filePath: string) => {
    for (const value of await readJsonl(filePath)) {
      if (!isProgressEntry(value) || value.event !== "cycle_end") continue;
      const started = startedAtMs(value);
      if (sinceMs !== undefined && started < sinceMs) continue;
      if (untilMs !== undefined && started > untilMs) continue;
      if (options.verifiedOnly) {
        const outcome = String(value.data.outcome ?? "");
        if (outcome === "cycle_skipped" || outcome === "verification_failed") continue;
      }
      if (options.outcome !== undefined) {
        const outcome = String(value.data.outcome ?? "");
        if (outcome !== options.outcome) continue;
      }
      entries.push(value);
    }
  };

  if (projectId) {
    await collect(join(stateDir, projectId, "PROGRESS.jsonl"));
  } else {
    for (const dir of readdirSync(stateDir)) {
      await collect(join(stateDir, dir, "PROGRESS.jsonl"));
    }
  }

  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return entries;
}

export async function loadCycleHistory(
  projectId: string | undefined,
  limit: number = 20,
  options: LoadCycleHistoryOptions = {},
): Promise<CycleHistoryRow[]> {
  const entries = await collectCycleEnds(projectId, options);
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

export interface CycleHistoryJsonRow {
  cycle_id: string;
  project_id: string;
  started_at: string;
  outcome: string;
  diff_stats: unknown;
  reason: string;
}

export async function loadCycleHistoryJson(
  projectId: string | undefined,
  limit: number = 20,
  options: LoadCycleHistoryOptions = {},
): Promise<CycleHistoryJsonRow[]> {
  const entries = await collectCycleEnds(projectId, options);
  return entries.slice(-limit).map((e) => ({
    cycle_id: e.cycle_id ?? "",
    project_id: e.project_id ?? "",
    started_at: new Date(startedAtMs(e)).toISOString(),
    outcome: String(e.data.outcome ?? ""),
    diff_stats: e.data.diff_stats ?? null,
    reason: String(e.data.reason ?? ""),
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
  byProject?: Record<string, ProjectCostSummary>,
): void {
  for (const row of rows) {
    const outcome = colorizeOutcome(row.outcome, useColor);
    const base = `${row.timestamp}\t${row.project}\t${row.cycle_id}\t${outcome}\t${row.duration}\t${row.sha_range}`;
    if (costs) {
      const c = costs[row.cycle_id];
      const invocations = c?.reviewer_invocations ?? 0;
      const tokens = c?.estimated_tokens ?? 0;
      let line = `${base}\t${invocations}\t${tokens}`;
      if (byProject) {
        const projTokens = byProject[row.project]?.estimated_tokens ?? 0;
        line = `${line}\t${projTokens}`;
      }
      console.log(line);
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

export interface ProjectCostSummary {
  project_id: string;
  reviewer_invocations: number;
  prompt_chars: number;
  estimated_tokens: number;
}

export interface CostsSummary {
  reviewer_invocations: number;
  prompt_chars: number;
  estimated_tokens: number;
  by_cycle: Record<string, CycleCostSummary>;
  by_project: Record<string, ProjectCostSummary>;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Load and filter ProgressEntry objects from a single project's PROGRESS.jsonl.
// Missing file returns []. Malformed lines are skipped silently; entries that
// don't pass isProgressEntry are discarded before filterFn sees them.
export async function loadProgressEvents(
  projectId: string,
  filterFn: (entry: ProgressEntry) => boolean,
): Promise<ProgressEntry[]> {
  const parsed = await readJsonl(progressPath(projectId));
  const out: ProgressEntry[] = [];
  for (const value of parsed) {
    if (isProgressEntry(value) && filterFn(value)) {
      out.push(value);
    }
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
    return { reviewer_invocations: 0, prompt_chars: 0, estimated_tokens: 0, by_cycle: {}, by_project: {} };
  }

  const { readdirSync } = require("fs");
  const isReviewerInvoked = (e: ProgressEntry) => e.event === "reviewer_invoked";
  // Track which project each entry came from so we can aggregate per-project
  // totals — entry.project_id is set by appendProgress, but we trust the
  // directory name as a fallback.
  const tagged: Array<{ project: string; entry: ProgressEntry }> = [];

  const tag = async (proj: string) => {
    for (const e of await loadProgressEvents(proj, isReviewerInvoked)) {
      tagged.push({ project: e.project_id ?? proj, entry: e });
    }
  };

  if (projectId) {
    await tag(projectId);
  } else {
    for (const dir of readdirSync(stateDir)) {
      await tag(dir);
    }
  }

  const byCycle: Record<string, CycleCostSummary> = {};
  const byProject: Record<string, ProjectCostSummary> = {};
  let totalChars = 0;

  for (const { project, entry: e } of tagged) {
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

    const projExisting = byProject[project];
    if (projExisting) {
      projExisting.reviewer_invocations += 1;
      projExisting.prompt_chars += chars;
      projExisting.estimated_tokens = estimateTokens(projExisting.prompt_chars);
    } else {
      byProject[project] = {
        project_id: project,
        reviewer_invocations: 1,
        prompt_chars: chars,
        estimated_tokens: estimateTokens(chars),
      };
    }
  }

  return {
    reviewer_invocations: tagged.length,
    prompt_chars: totalChars,
    estimated_tokens: estimateTokens(totalChars),
    by_cycle: byCycle,
    by_project: byProject,
  };
}
