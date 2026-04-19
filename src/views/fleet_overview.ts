// GeneralStaff — Phase 6 data-contract: fleet overview view module (gs-221).
//
// Aggregates per-project status + fleet-wide totals into a single shape
// suitable for the Phase 5 Fleet Overview HTML reference. Pure data — no
// rendering. CLI wiring lives in a later task.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadProjects } from "../projects";
import { getRootDir } from "../state";
import { countRemainingWorkDetailed } from "../work_detection";
import { isProgressEntry } from "../types";
import type { ProjectConfig, ProjectState } from "../types";

export interface FleetOverviewProjectRow {
  id: string;
  last_cycle_at: string | null;
  last_cycle_outcome: string | null;
  cycles_total: number;
  verified: number;
  failed: number;
  bot_pickable: number;
  auto_merge: boolean;
  branch: string;
  priority: number;
}

export interface FleetOverviewAggregates {
  total_cycles: number;
  total_verified: number;
  total_failed: number;
  pass_rate: number;
  project_count: number;
  slot_efficiency_recent: number | null;
}

export interface FleetOverviewData {
  projects: FleetOverviewProjectRow[];
  aggregates: FleetOverviewAggregates;
  rendered_at: string;
}

const SLOT_EFFICIENCY_MIN_SAMPLES = 5;
const SLOT_EFFICIENCY_WINDOW = 10;

async function loadProjectStateFile(
  project: ProjectConfig,
): Promise<ProjectState | null> {
  const path = join(project.path, "state", project.id, "STATE.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProjectState;
  } catch {
    return null;
  }
}

interface ProgressCounts {
  cycles_total: number;
  verified: number;
  failed: number;
}

async function countProjectCycles(
  project: ProjectConfig,
): Promise<ProgressCounts> {
  const path = join(project.path, "state", project.id, "PROGRESS.jsonl");
  const counts: ProgressCounts = { cycles_total: 0, verified: 0, failed: 0 };
  if (!existsSync(path)) return counts;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isProgressEntry(parsed) || parsed.event !== "cycle_end") continue;
    counts.cycles_total += 1;
    const outcome = parsed.data.outcome;
    if (outcome === "verified" || outcome === "verified_weak") {
      counts.verified += 1;
    } else if (outcome === "verification_failed") {
      counts.failed += 1;
    }
  }
  return counts;
}

// Compute mean parallel_efficiency over the most recent N session_complete
// events with max_parallel_slots > 1. Returns null if fewer than
// SLOT_EFFICIENCY_MIN_SAMPLES such events exist.
async function computeSlotEfficiencyRecent(): Promise<number | null> {
  const path = join(getRootDir(), "state", "_fleet", "PROGRESS.jsonl");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const samples: number[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isProgressEntry(parsed) || parsed.event !== "session_complete") continue;
    const d = parsed.data;
    const slots = d.max_parallel_slots;
    if (typeof slots !== "number" || slots <= 1) continue;
    const eff = d.parallel_efficiency;
    if (typeof eff !== "number") continue;
    samples.push(eff);
    if (samples.length >= SLOT_EFFICIENCY_WINDOW) break;
  }
  if (samples.length < SLOT_EFFICIENCY_MIN_SAMPLES) return null;
  const sum = samples.reduce((a, b) => a + b, 0);
  return sum / samples.length;
}

export async function getFleetOverview(): Promise<FleetOverviewData> {
  const projects = await loadProjects();

  const rows: FleetOverviewProjectRow[] = await Promise.all(
    projects.map(async (project) => {
      const [state, counts, breakdown] = await Promise.all([
        loadProjectStateFile(project),
        countProjectCycles(project),
        countRemainingWorkDetailed(project),
      ]);
      return {
        id: project.id,
        last_cycle_at: state?.last_cycle_at ?? null,
        last_cycle_outcome: state?.last_cycle_outcome ?? null,
        cycles_total: counts.cycles_total,
        verified: counts.verified,
        failed: counts.failed,
        bot_pickable: breakdown.pending_bot_pickable,
        auto_merge: project.auto_merge,
        branch: project.branch,
        priority: project.priority,
      };
    }),
  );

  const totals = rows.reduce(
    (acc, r) => {
      acc.total_cycles += r.cycles_total;
      acc.total_verified += r.verified;
      acc.total_failed += r.failed;
      return acc;
    },
    { total_cycles: 0, total_verified: 0, total_failed: 0 },
  );

  const denom = totals.total_verified + totals.total_failed;
  const pass_rate = denom === 0 ? 0 : totals.total_verified / denom;

  const slot_efficiency_recent = await computeSlotEfficiencyRecent();

  const aggregates: FleetOverviewAggregates = {
    total_cycles: totals.total_cycles,
    total_verified: totals.total_verified,
    total_failed: totals.total_failed,
    pass_rate,
    project_count: rows.length,
    slot_efficiency_recent,
  };

  return {
    projects: rows,
    aggregates,
    rendered_at: new Date().toISOString(),
  };
}
