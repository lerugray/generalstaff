// GeneralStaff — fleet summary: dashboard snapshot across all projects

import { existsSync, readdirSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { getRootDir } from "./state";
import { isProgressEntry, type ProgressEntry } from "./types";
import { formatDuration } from "./format";

export interface OutcomeCounts {
  verified: number;
  verified_weak: number;
  verification_failed: number;
  cycle_skipped: number;
  other: number;
}

export interface FleetSummary {
  projects: number;
  cycles_total: number;
  outcomes: OutcomeCounts;
  duration_seconds: number;
  tasks_pending: number;
  tasks_by_project: Record<string, number>;
}

export interface TestCounts {
  files: number;
  cases: number;
}

async function readCycleEnds(filePath: string): Promise<ProgressEntry[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  const out: ProgressEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isProgressEntry(parsed) && parsed.event === "cycle_end") {
        out.push(parsed);
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

function countPendingTasksSync(tasksPath: string): number {
  if (!existsSync(tasksPath)) return 0;
  try {
    const raw = require("fs").readFileSync(tasksPath, "utf8");
    if (!raw.trim()) return 0;
    const tasks = JSON.parse(raw) as Array<{ status?: string }>;
    if (!Array.isArray(tasks)) return 0;
    return tasks.filter(
      (t) => t && t.status !== "done" && t.status !== "skipped",
    ).length;
  } catch {
    return 0;
  }
}

export async function buildFleetSummary(): Promise<FleetSummary> {
  const stateDir = join(getRootDir(), "state");
  const empty: FleetSummary = {
    projects: 0,
    cycles_total: 0,
    outcomes: {
      verified: 0,
      verified_weak: 0,
      verification_failed: 0,
      cycle_skipped: 0,
      other: 0,
    },
    duration_seconds: 0,
    tasks_pending: 0,
    tasks_by_project: {},
  };

  if (!existsSync(stateDir)) return empty;

  const projectDirs = readdirSync(stateDir).filter((name) => {
    const p = join(stateDir, name);
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  const summary: FleetSummary = {
    ...empty,
    outcomes: { ...empty.outcomes },
    tasks_by_project: {},
  };

  summary.projects = projectDirs.length;

  for (const projectId of projectDirs) {
    const projectDir = join(stateDir, projectId);

    const ends = await readCycleEnds(join(projectDir, "PROGRESS.jsonl"));
    for (const e of ends) {
      summary.cycles_total += 1;
      const outcome = String(e.data.outcome ?? "");
      switch (outcome) {
        case "verified":
          summary.outcomes.verified += 1;
          break;
        case "verified_weak":
          summary.outcomes.verified_weak += 1;
          break;
        case "verification_failed":
          summary.outcomes.verification_failed += 1;
          break;
        case "cycle_skipped":
          summary.outcomes.cycle_skipped += 1;
          break;
        default:
          summary.outcomes.other += 1;
          break;
      }
      const dur = e.data.duration_seconds;
      if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
        summary.duration_seconds += dur;
      }
    }

    const pending = countPendingTasksSync(join(projectDir, "tasks.json"));
    if (pending > 0) {
      summary.tasks_by_project[projectId] = pending;
      summary.tasks_pending += pending;
    }
  }

  return summary;
}

const TEST_CALL_RE = /^\s*(?:test|it)(?:\.\w+)?\s*\(/gm;

export function countTests(testsDir: string): TestCounts {
  const result: TestCounts = { files: 0, cases: 0 };
  if (!existsSync(testsDir)) return result;

  const stack: string[] = [testsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "fixtures" || name === "node_modules") continue;
        stack.push(full);
      } else if (st.isFile() && name.endsWith(".test.ts")) {
        result.files += 1;
        try {
          const content = require("fs").readFileSync(full, "utf8");
          const matches = content.match(TEST_CALL_RE);
          if (matches) result.cases += matches.length;
        } catch { /* skip unreadable */ }
      }
    }
  }
  return result;
}

function pct(n: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

export function formatSummary(
  summary: FleetSummary,
  tests: TestCounts | null,
): string {
  const lines: string[] = [];
  lines.push("=== GeneralStaff Fleet Summary ===");
  lines.push("");
  lines.push(`Projects:        ${summary.projects}`);
  lines.push("");
  lines.push("Cycles:");
  lines.push(`  Total:         ${summary.cycles_total}`);
  if (summary.cycles_total > 0) {
    lines.push(`  Verified:      ${summary.outcomes.verified}  (${pct(summary.outcomes.verified, summary.cycles_total)})`);
    if (summary.outcomes.verified_weak > 0) {
      lines.push(`  Verified-weak: ${summary.outcomes.verified_weak}  (${pct(summary.outcomes.verified_weak, summary.cycles_total)})`);
    }
    lines.push(`  Failed:        ${summary.outcomes.verification_failed}  (${pct(summary.outcomes.verification_failed, summary.cycles_total)})`);
    lines.push(`  Skipped:       ${summary.outcomes.cycle_skipped}  (${pct(summary.outcomes.cycle_skipped, summary.cycles_total)})`);
    if (summary.outcomes.other > 0) {
      lines.push(`  Other:         ${summary.outcomes.other}`);
    }
  }
  lines.push("");
  lines.push("Duration:");
  lines.push(`  Total:         ${formatDuration(summary.duration_seconds)}`);
  if (summary.cycles_total > 0) {
    const avg = summary.duration_seconds / summary.cycles_total;
    lines.push(`  Avg/cycle:     ${formatDuration(avg)}`);
  }
  lines.push("");
  lines.push("Tasks:");
  lines.push(`  Pending:       ${summary.tasks_pending}`);
  const projectsWithTasks = Object.keys(summary.tasks_by_project);
  if (projectsWithTasks.length > 0) {
    for (const p of projectsWithTasks.sort()) {
      lines.push(`    ${p}: ${summary.tasks_by_project[p]}`);
    }
  }
  if (tests) {
    lines.push("");
    lines.push("Tests:");
    lines.push(`  Files:         ${tests.files}`);
    lines.push(`  Cases:         ${tests.cases}`);
  }
  return lines.join("\n");
}
