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

/**
 * Pick up to `maxCount` eligible projects in picker-preferred order.
 *
 * The override file (`next_project.txt`) claims the first slot when its
 * target is eligible; subsequent slots are filled from priority × staleness
 * scoring. Every returned project is distinct, not in `skipProjectIds`,
 * and not currently running (`isBotRunning` returns false). Fewer than
 * `maxCount` picks are returned when fewer eligible projects exist —
 * empty slots stay idle rather than fill with low-value work (the
 * Hammerstein / stupid-industrious avoidance).
 *
 * `pickNextProject` below is a back-compat `maxCount=1` wrapper for the
 * Phase 1-3 sequential dispatcher path; `session.ts` (gs-186) calls
 * `pickNextProjects` directly when `max_parallel_slots > 1`. See
 * `DESIGN.md` §v6 for the full design narrative.
 *
 * @param projects Eligible project configs.
 * @param config Dispatcher config (used for the override-file path).
 * @param fleet Current fleet state (used for staleness scoring).
 * @param skipProjectIds Projects to exclude from this pick (soft-skipped,
 *   cap-reached, or currently running).
 * @param maxCount Maximum number of picks to return. `0` returns `[]`.
 * @param sessionExcludedTaskIdsByProject gs-290: per-project sets of task
 *   ids excluded for the rest of this session after an empty-diff
 *   `verified_weak` cycle (parallel empty-queue filter + chaining).
 * @returns Up to `maxCount` `{project, reason}` entries, each reasoning
 *   string tagged with `override:` (first slot only) or `picker:`
 *   (subsequent slots).
 */
// gs-185 (Phase 4 step 1): return up to `maxCount` eligible projects in
// picker-preferred order. The override file claims the first slot if
// present; subsequent slots are filled from priority × staleness scoring.
// Every returned project is distinct, not in skipProjectIds, and not
// currently running (isBotRunning=false). `pickNextProject` below is a
// back-compat wrapper that requests maxCount=1 — preserves the Phase 1-3
// sequential dispatcher behaviour while `session.ts` (gs-186) layers on
// parallelism separately. See DESIGN.md §v6 for the full phased plan.
//
// gs-232: in parallel mode (maxCount > 1), skip projects whose queue
// has no bot-pickable work. Wave-3/4 runs showed parallel_efficiency
// ~0.54 with slot_idle_seconds ~2000-2400s because empty-queue projects
// (gamr, raybrain in their post-Phase-1 idle state) kept being picked
// into slots, burning ~30-60s of engineer-subprocess startup for an
// empty-diff verified_weak cycle each round. Filtering at pick time
// lets the session soft-stop sooner when no project has work at all,
// and spreads real cycles over projects that actually need them.
//
// Sequential mode (maxCount == 1) is intentionally NOT filtered here —
// the Phase 1-3 contract is that `pickNextProject` returns the
// picker's best guess regardless of queue depth, and chaining-time
// `shouldChain` / `hasMoreWork` gates handle the empty-queue case
// downstream. Changing that behaviour would break every call site
// written against the single-pick contract (e.g. `session.ts`'s
// sequential loop, `status` / dry-run preview commands). The filter
// keys on `maxCount > 1` exclusively so N=1 stays bit-for-bit identical.
export async function pickNextProjects(
  projects: ProjectConfig[],
  config: DispatcherConfig,
  fleet: FleetState,
  skipProjectIds: Set<string> = new Set(),
  maxCount: number = 1,
  sessionExcludedTaskIdsByProject?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Array<{ project: ProjectConfig; reason: string }>> {
  if (maxCount <= 0) return [];

  const results: Array<{ project: ProjectConfig; reason: string }> = [];
  // claimed = already-excluded ids + ids already selected in this call
  // (so the same project can't fill multiple slots).
  const claimed = new Set<string>(skipProjectIds);

  // gs-232: parallel-mode-only empty-queue filter (see function doc).
  const skipEmptyQueue = maxCount > 1;

  // Override file gets the first slot when the pointed-at project is
  // eligible. With maxCount > 1, the remaining slots still come from
  // the scorer — so the override acts as a "prefer this one first"
  // hint in the parallel case, not an exclusive claim.
  const override = await readOverrideFile(config);
  if (override) {
    const project = projects.find((p) => p.id === override);
    if (project && !claimed.has(project.id) && !isBotRunning(project).running) {
      const hasWork = skipEmptyQueue
        ? await hasMoreWork(
            project,
            sessionExcludedTaskIdsByProject?.get(project.id),
          )
        : true;
      if (hasWork) {
        results.push({
          project,
          reason: `override: next_project.txt = "${override}"`,
        });
        claimed.add(project.id);
      } else {
        // gs-232: claim-and-skip so the picker loop doesn't re-evaluate
        // the same empty-queue project (and re-run hasMoreWork on it).
        claimed.add(project.id);
      }
    }
  }

  if (results.length < maxCount) {
    const scored = scoreProjects(
      projects.filter((p) => !claimed.has(p.id)),
      fleet,
    );
    for (const { project, reason } of scored) {
      if (results.length >= maxCount) break;
      if (isBotRunning(project).running) continue;
      if (
        skipEmptyQueue &&
        !(await hasMoreWork(
          project,
          sessionExcludedTaskIdsByProject?.get(project.id),
        ))
      ) {
        continue;
      }
      results.push({ project, reason: `picker: ${reason}` });
      claimed.add(project.id);
    }
  }

  return results;
}

export async function pickNextProject(
  projects: ProjectConfig[],
  config: DispatcherConfig,
  fleet: FleetState,
  skipProjectIds: Set<string> = new Set(),
  sessionExcludedTaskIdsByProject?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<{ project: ProjectConfig; reason: string } | null> {
  const picks = await pickNextProjects(
    projects,
    config,
    fleet,
    skipProjectIds,
    1,
    sessionExcludedTaskIdsByProject,
  );
  return picks[0] ?? null;
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
  sessionExcludedTaskIds?: ReadonlySet<string>,
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

  const moreWork = await hasMoreWork(project, sessionExcludedTaskIds);
  if (!moreWork) {
    return { chain: false, reason: "no remaining work for this project" };
  }

  return { chain: true, reason: "more work, budget ok, last cycle passed" };
}
