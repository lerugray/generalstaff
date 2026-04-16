// GeneralStaff — dispatcher / picker (build step 13)
// Priority × staleness picker, override file, chaining rules (Q1)

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { getRootDir, loadFleetState, getProjectFleetState } from "./state";
import { hasMoreWork } from "./work_detection";
import { isBotRunning, isStopFilePresent } from "./safety";
import type {
  ProjectConfig,
  DispatcherConfig,
  CycleResult,
  FleetState,
} from "./types";

// --- Picker: priority × staleness ---

interface PickerScore {
  project: ProjectConfig;
  score: number;
  reason: string;
}

function daysSinceLastCycle(
  fleet: FleetState,
  projectId: string,
): number {
  const state = fleet.projects[projectId];
  if (!state?.last_cycle_at) {
    return 999; // never run → maximum staleness
  }
  const lastCycle = new Date(state.last_cycle_at).getTime();
  return (Date.now() - lastCycle) / (1000 * 60 * 60 * 24);
}

export function scoreProjects(
  projects: ProjectConfig[],
  fleet: FleetState,
): PickerScore[] {
  return projects
    .map((p) => {
      const staleness = daysSinceLastCycle(fleet, p.id) + 1;
      const score = (1 / p.priority) * staleness;
      return {
        project: p,
        score,
        reason: `priority=${p.priority}, staleness=${staleness.toFixed(1)}d`,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score; // highest score first
      // Tiebreaker: prefer project with fewer total_cycles (spread work evenly)
      const aCycles = fleet.projects[a.project.id]?.total_cycles ?? 0;
      const bCycles = fleet.projects[b.project.id]?.total_cycles ?? 0;
      return aCycles - bCycles;
    });
}

// --- Override file ---

async function readOverrideFile(
  config: DispatcherConfig,
): Promise<string | null> {
  const filePath = join(getRootDir(), config.override_file);
  if (!existsSync(filePath)) return null;
  try {
    const content = await readFile(filePath, "utf8");
    const id = content.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// --- Pick next project ---

export async function pickNextProject(
  projects: ProjectConfig[],
  config: DispatcherConfig,
  fleet: FleetState,
  skipProjectIds: Set<string> = new Set(),
): Promise<{ project: ProjectConfig; reason: string } | null> {
  // Check override file first
  const override = await readOverrideFile(config);
  if (override) {
    const project = projects.find((p) => p.id === override);
    if (project && !skipProjectIds.has(project.id)) {
      return { project, reason: `override: next_project.txt = "${override}"` };
    }
  }

  // Score and pick
  const scored = scoreProjects(
    projects.filter((p) => !skipProjectIds.has(p.id)),
    fleet,
  );

  for (const { project, reason } of scored) {
    // Skip if bot already running
    const running = isBotRunning(project);
    if (running.running) continue;

    return { project, reason: `picker: ${reason}` };
  }

  return null; // no eligible project
}

// --- Session plan estimate (preview) ---

export interface SessionPlanPick {
  project_id: string;
  start_minute: number;
  duration_minutes: number;
}

export interface SessionPlanPerProject {
  project_id: string;
  cycle_count: number;
}

export interface SessionPlanEstimate {
  picks: SessionPlanPick[];
  per_project: SessionPlanPerProject[];
  total_cycles: number;
  budget_used_minutes: number;
  budget_remaining_minutes: number;
}

export function estimateSessionPlan(
  projects: ProjectConfig[],
  fleet: FleetState,
  budgetMinutes: number,
  maxCyclesPerProject: number = Infinity,
): SessionPlanEstimate {
  // Deep clone fleet so simulation does not mutate the caller's state
  const simFleet: FleetState = {
    version: fleet.version,
    updated_at: fleet.updated_at,
    projects: Object.fromEntries(
      Object.entries(fleet.projects).map(([id, s]) => [id, { ...s }]),
    ),
  };
  for (const p of projects) {
    if (!simFleet.projects[p.id]) {
      simFleet.projects[p.id] = {
        last_cycle_at: null,
        last_cycle_outcome: null,
        total_cycles: 0,
        total_verified: 0,
        total_failed: 0,
        accumulated_minutes: 0,
      };
    }
  }

  const picks: SessionPlanPick[] = [];
  const perCount = new Map<string, number>();
  const capped = new Set<string>();
  let elapsed = 0;

  while (elapsed < budgetMinutes) {
    const eligible = projects.filter((p) => !capped.has(p.id));
    if (eligible.length === 0) break;

    const scored = scoreProjects(eligible, simFleet);
    const top = scored[0];
    if (!top) break;

    const needed = top.project.cycle_budget_minutes + 5;
    if (elapsed + needed > budgetMinutes) break;

    picks.push({
      project_id: top.project.id,
      start_minute: elapsed,
      duration_minutes: needed,
    });
    elapsed += needed;

    const count = (perCount.get(top.project.id) ?? 0) + 1;
    perCount.set(top.project.id, count);

    // Reset staleness for the just-run project so the picker can rotate
    const state = simFleet.projects[top.project.id];
    if (state) {
      state.last_cycle_at = new Date().toISOString();
      state.total_cycles += 1;
    }

    if (count >= maxCyclesPerProject) {
      capped.add(top.project.id);
    }
  }

  const perProject: SessionPlanPerProject[] = projects
    .map((p) => ({
      project_id: p.id,
      cycle_count: perCount.get(p.id) ?? 0,
    }))
    .sort((a, b) => b.cycle_count - a.cycle_count);

  return {
    picks,
    per_project: perProject,
    total_cycles: picks.length,
    budget_used_minutes: elapsed,
    budget_remaining_minutes: budgetMinutes - elapsed,
  };
}

// --- Chaining decision (Q1) ---

export interface ChainingDecision {
  chain: boolean;
  reason: string;
}

export async function shouldChain(
  lastCycle: CycleResult,
  project: ProjectConfig,
  cyclesOnProject: number,
  maxCyclesPerProject: number,
  remainingMinutes: number,
): Promise<ChainingDecision> {
  if (lastCycle.final_outcome === "verification_failed") {
    return { chain: false, reason: "last cycle failed verification" };
  }

  if (lastCycle.final_outcome === "cycle_skipped") {
    return { chain: false, reason: "last cycle was skipped" };
  }

  if (cyclesOnProject >= maxCyclesPerProject) {
    return { chain: false, reason: "per-project cycle cap reached" };
  }

  const nextMinimum = project.cycle_budget_minutes + 5;
  if (remainingMinutes < nextMinimum) {
    return { chain: false, reason: "insufficient session budget" };
  }

  const moreWork = await hasMoreWork(project);
  if (!moreWork) {
    return { chain: false, reason: "no remaining work for this project" };
  }

  return { chain: true, reason: "more work, budget ok, last cycle passed" };
}
