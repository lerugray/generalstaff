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

export async function tailProgressLog(
  projectId: string | undefined,
  lines: number = 20,
) {
  if (projectId) {
    await tailSingleProject(projectId, lines);
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

    const tail = entries.slice(-lines);
    for (const entry of tail) {
      printEntry(entry);
    }

    if (entries.length === 0) {
      console.log("No audit log entries found.");
    }
  }
}

async function tailSingleProject(projectId: string, lines: number) {
  const filePath = progressPath(projectId);
  if (!existsSync(filePath)) {
    console.log(`No PROGRESS.jsonl for project "${projectId}".`);
    return;
  }

  const content = await readFile(filePath, "utf8");
  const allLines = content.trim().split("\n").filter(Boolean);
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

export async function loadCycleHistory(
  projectId: string | undefined,
  limit: number = 20,
): Promise<CycleHistoryRow[]> {
  const stateDir = join(getRootDir(), "state");
  if (!existsSync(stateDir)) return [];

  const entries: ProgressEntry[] = [];
  const { readdirSync } = require("fs");

  if (projectId) {
    const filePath = join(stateDir, projectId, "PROGRESS.jsonl");
    if (!existsSync(filePath)) return [];
    const content = await readFile(filePath, "utf8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (isProgressEntry(parsed) && parsed.event === "cycle_end") {
          entries.push(parsed);
        }
      } catch { /* skip malformed */ }
    }
  } else {
    for (const dir of readdirSync(stateDir)) {
      const filePath = join(stateDir, dir, "PROGRESS.jsonl");
      if (!existsSync(filePath)) continue;
      const content = await readFile(filePath, "utf8");
      for (const line of content.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (isProgressEntry(parsed) && parsed.event === "cycle_end") {
            entries.push(parsed);
          }
        } catch { /* skip malformed */ }
      }
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

export function printHistoryTable(rows: CycleHistoryRow[]): void {
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
    console.log(keys.map((k) => pad(row[k], widths[k])).join("  "));
  }
}

export function printHistoryCompact(rows: CycleHistoryRow[]): void {
  for (const row of rows) {
    console.log(`${row.timestamp}\t${row.project}\t${row.cycle_id}\t${row.outcome}\t${row.duration}\t${row.sha_range}`);
  }
}
