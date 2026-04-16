// GeneralStaff — audit writer (build step 7)
// Append-only PROGRESS.jsonl per project (Hard Rule #9)

import { existsSync, mkdirSync } from "fs";
import { appendFile, readFile } from "fs/promises";
import { join, dirname } from "path";
import { getRootDir } from "./state";
import type { ProgressEntry, ProgressEventType } from "./types";

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
            entries.push(JSON.parse(line));
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
      printEntry(JSON.parse(line));
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
