// GeneralStaff — fleet summary: dashboard snapshot across all projects

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getRootDir } from "./state";
import { loadProgressEvents, readJsonl } from "./audit";
import { formatBytes, formatDuration, formatPercent } from "./format";
import { isProgressEntry } from "./types";
import { loadProjects } from "./projects";

export interface OutcomeCounts {
  verified: number;
  verified_weak: number;
  verification_failed: number;
  cycle_skipped: number;
  other: number;
}

export interface ProjectCycleStats {
  verified: number;
  total: number;
}

export interface FleetSummary {
  projects: number;
  cycles_total: number;
  outcomes: OutcomeCounts;
  duration_seconds: number;
  tasks_pending: number;
  tasks_by_project: Record<string, number>;
  cycles_by_project: Record<string, ProjectCycleStats>;
}

export interface TestCounts {
  files: number;
  cases: number;
}

export interface DiskUsage {
  logs: number;
  digests: number;
  state: number;
  total: number;
}

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        total += st.size;
      }
    }
  }
  return total;
}

export function computeDiskUsage(rootDir?: string): DiskUsage {
  const root = rootDir ?? getRootDir();
  const logs = dirSizeBytes(join(root, "logs"));
  const digests = dirSizeBytes(join(root, "digests"));
  const state = dirSizeBytes(join(root, "state"));
  return { logs, digests, state, total: logs + digests + state };
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

export async function buildFleetSummary(
  projectFilter?: string,
): Promise<FleetSummary> {
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
    cycles_by_project: {},
  };

  if (!existsSync(stateDir)) return empty;

  let projectDirs = readdirSync(stateDir).filter((name) => {
    const p = join(stateDir, name);
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  // Filter to registered projects only. Orphan state dirs (e.g.
  // left over from a deregistered project or test fixtures) would
  // otherwise inflate the project count and confuse anyone reading
  // `summary`. If projects.yaml is missing or unreadable, fall back
  // to the full set of state dirs so a partly-configured install
  // still reports something useful.
  try {
    const registered = await loadProjects();
    const registeredIds = new Set(registered.map((p) => p.id));
    projectDirs = projectDirs.filter((name) => registeredIds.has(name));
  } catch {
    // projects.yaml missing or malformed — fall back silently.
  }

  if (projectFilter) {
    projectDirs = projectDirs.filter((name) => name === projectFilter);
  }

  const summary: FleetSummary = {
    ...empty,
    outcomes: { ...empty.outcomes },
    tasks_by_project: {},
    cycles_by_project: {},
  };

  summary.projects = projectDirs.length;

  for (const projectId of projectDirs) {
    const projectDir = join(stateDir, projectId);

    const ends = await loadProgressEvents(
      projectId,
      (e) => e.event === "cycle_end",
    );
    for (const e of ends) {
      summary.cycles_total += 1;
      if (!summary.cycles_by_project[projectId]) {
        summary.cycles_by_project[projectId] = { verified: 0, total: 0 };
      }
      summary.cycles_by_project[projectId].total += 1;
      const outcome = String(e.data.outcome ?? "");
      switch (outcome) {
        case "verified":
          summary.outcomes.verified += 1;
          summary.cycles_by_project[projectId].verified += 1;
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
  disk?: DiskUsage | null,
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
    const projectsWithCycles = Object.keys(summary.cycles_by_project).sort();
    if (projectsWithCycles.length > 0) {
      lines.push("  By project:");
      for (const p of projectsWithCycles) {
        const stats = summary.cycles_by_project[p];
        const rate = formatPercent(stats.verified / stats.total);
        lines.push(
          `    ${p}: Success rate: ${rate} (${stats.verified}/${stats.total} verified)`,
        );
      }
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
  if (disk) {
    lines.push("");
    lines.push("Disk Usage:");
    lines.push(`  logs/:         ${formatBytes(disk.logs)}`);
    lines.push(`  digests/:      ${formatBytes(disk.digests)}`);
    lines.push(`  state/:        ${formatBytes(disk.state)}`);
    lines.push(`  Total:         ${formatBytes(disk.total)}`);
  }
  return lines.join("\n");
}

// --- Today's session summary (gs-180) ---

export interface CycleDurationPercentiles {
  p50: number;
  p90: number;
  max: number;
  count: number;
}

// gs-260: rolling fleet-level mean of session-level parallel_efficiency.
// Only populated when at least one session_complete event in the window
// carried the field (set by parallel-mode sessions only — see gs-186).
export interface ParallelEfficiencyMetrics {
  mean: number;
  sessions: number;
}

export interface TodaySessionSummary {
  date: string;                              // YYYY-MM-DD (UTC midnight cutoff)
  cycles_total: number;
  verified: number;
  verification_failed: number;
  avg_cycle_duration_seconds: number;
  wall_clock_minutes: number;
  last_session_end: string | null;
  // gs-252: percentiles over duration_seconds across the same filtered
  // cycle_end pool that feeds avg_cycle_duration_seconds. null when no
  // cycles match the window.
  cycle_duration: CycleDurationPercentiles | null;
  // gs-260: mean parallel_efficiency across session_complete events in
  // the window that carried that field. null when none did (e.g. fully
  // sequential fleet).
  parallel_efficiency: ParallelEfficiencyMetrics | null;
}

// gs-252: nearest-rank percentile (1-indexed). Sorted asc; for percentile p
// (0..1) the rank is ceil(p * n), index is rank - 1 clamped to [0, n-1].
function nearestRankPercentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * n));
  return sortedAsc[Math.min(n - 1, rank - 1)];
}

export async function buildTodaySessionSummary(
  now: Date = new Date(),
  sinceMs?: number,
): Promise<TodaySessionSummary> {
  // gs-247: `--since=<iso>` replaces the default "today UTC midnight"
  // cutoff so operators can scope the summary to an arbitrary window
  // (e.g. the last overnight run). The cutoff remains inclusive.
  const cutoffMs =
    typeof sinceMs === "number" && Number.isFinite(sinceMs)
      ? sinceMs
      : Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0, 0, 0, 0,
        );
  const date = new Date(cutoffMs).toISOString().slice(0, 10);

  const result: TodaySessionSummary = {
    date,
    cycles_total: 0,
    verified: 0,
    verification_failed: 0,
    avg_cycle_duration_seconds: 0,
    wall_clock_minutes: 0,
    last_session_end: null,
    cycle_duration: null,
    parallel_efficiency: null,
  };

  const stateDir = join(getRootDir(), "state");
  if (!existsSync(stateDir)) return result;

  let totalDurationSeconds = 0;
  let lastSessionEndMs = -Infinity;
  const durations: number[] = [];
  const parallelEffs: number[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(stateDir);
  } catch {
    return result;
  }

  for (const dir of projectDirs) {
    const full = join(stateDir, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }

    const logPath = join(full, "PROGRESS.jsonl");
    for (const value of await readJsonl(logPath)) {
      if (!isProgressEntry(value)) continue;
      const ts = Date.parse(value.timestamp);
      if (Number.isNaN(ts) || ts < cutoffMs) continue;

      if (dir === "_fleet") {
        if (
          value.event === "session_complete" ||
          value.event === "session_end"
        ) {
          const mins = value.data.duration_minutes;
          if (typeof mins === "number" && Number.isFinite(mins) && mins > 0) {
            result.wall_clock_minutes += mins;
          }
          if (ts > lastSessionEndMs) {
            lastSessionEndMs = ts;
            result.last_session_end = value.timestamp;
          }
          // gs-260: collect parallel_efficiency from session_complete
          // events that carry the field. The field is only set in
          // parallel mode (max_parallel_slots > 1; see gs-186), so its
          // mere presence is the signal.
          if (value.event === "session_complete") {
            const eff = value.data.parallel_efficiency;
            if (typeof eff === "number" && Number.isFinite(eff)) {
              parallelEffs.push(eff);
            }
          }
        }
      } else if (value.event === "cycle_end") {
        result.cycles_total += 1;
        const outcome = String(value.data.outcome ?? "");
        if (outcome === "verified") {
          result.verified += 1;
        } else if (outcome === "verification_failed") {
          result.verification_failed += 1;
        }
        const dur = value.data.duration_seconds;
        if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
          totalDurationSeconds += dur;
          durations.push(dur);
        }
      }
    }
  }

  if (result.cycles_total > 0) {
    result.avg_cycle_duration_seconds =
      totalDurationSeconds / result.cycles_total;
  }
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    result.cycle_duration = {
      p50: nearestRankPercentile(durations, 0.5),
      p90: nearestRankPercentile(durations, 0.9),
      max: durations[durations.length - 1],
      count: durations.length,
    };
  }
  if (parallelEffs.length > 0) {
    const sum = parallelEffs.reduce((a, b) => a + b, 0);
    result.parallel_efficiency = {
      mean: sum / parallelEffs.length,
      sessions: parallelEffs.length,
    };
  }
  return result;
}

export function formatTodaySessionSummary(s: TodaySessionSummary): string {
  const lines: string[] = [];
  lines.push(`=== Today's Session Summary (UTC ${s.date}) ===`);
  lines.push(`Cycles total:              ${s.cycles_total}`);
  lines.push(`Verified:                  ${s.verified}`);
  lines.push(`Verification failed:       ${s.verification_failed}`);
  lines.push(
    `Average cycle duration:    ${
      s.cycles_total > 0 ? formatDuration(s.avg_cycle_duration_seconds) : "n/a"
    }`,
  );
  lines.push(`Total bot wall-clock:      ${s.wall_clock_minutes} min`);
  lines.push(`Last session end:          ${s.last_session_end ?? "n/a"}`);
  if (s.cycle_duration) {
    const cd = s.cycle_duration;
    lines.push(
      `cycle_duration:            p50=${Math.round(cd.p50)}s p90=${Math.round(cd.p90)}s max=${Math.round(cd.max)}s`,
    );
  } else {
    lines.push(`cycle_duration:            (no cycles)`);
  }
  // gs-260: rolling fleet-level parallel_efficiency. Omit entirely when
  // no parallel sessions matched — sequential-only fleets shouldn't see
  // a metric whose denominator is zero.
  if (s.parallel_efficiency) {
    const pe = s.parallel_efficiency;
    lines.push(
      `parallel_efficiency:       ${pe.mean.toFixed(2)} (over ${pe.sessions} parallel session${pe.sessions === 1 ? "" : "s"})`,
    );
  }
  return lines.join("\n");
}
