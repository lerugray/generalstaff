// GeneralStaff — phase progression detector (Phase B v1)
// FUTURE-DIRECTIONS-2026-04-19 §2.
//
// Runs at session start (called from session.ts) per registered
// project. For each project that has a ROADMAP.yaml, evaluates
// the current phase's completion_criteria. If all pass AND the
// phase has a non-terminal next_phase, writes a sentinel file
// at state/<project>/PHASE_READY.json + emits a
// phase_ready_for_advance event to PROGRESS.jsonl.
//
// Auto-advance is OFF by design (commander gate, per design doc
// §2 "start here, relax later"). The sentinel is a notification
// mechanism — the commander still runs `gs phase advance` to
// actually transition. `phase advance` clears the sentinel after
// a successful transition.

import { existsSync } from "fs";
import { unlink, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import {
  loadRoadmap,
  findPhase,
  evaluateCriteria,
  allPassed,
  roadmapExists,
  executePhaseAdvance,
} from "./phase";
import { loadPhaseState } from "./phase_state";
import { appendProgress } from "./audit";
import { getRootDir } from "./state";
import type {
  ProjectConfig,
  PhaseReadySentinel,
  PhaseCriterionResult,
} from "./types";

export type DetectionResult =
  | { kind: "no_roadmap" }
  | {
      kind: "ready";
      from_phase: string;
      to_phase: string;
      criteria_results: PhaseCriterionResult[];
    }
  | {
      kind: "auto_advanced";
      from_phase: string;
      to_phase: string;
      seeded_task_ids: string[];
      criteria_results: PhaseCriterionResult[];
    }
  | {
      kind: "not_ready";
      current_phase: string;
      criteria_results: PhaseCriterionResult[];
    }
  | { kind: "terminal_complete"; current_phase: string }
  | { kind: "error"; message: string };

export function phaseReadySentinelPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "PHASE_READY.json");
}

export function phaseReadySentinelExists(projectId: string): boolean {
  return existsSync(phaseReadySentinelPath(projectId));
}

// Atomic write helper local to this module — same pattern as
// phase_state.ts. Avoids re-exporting from state.ts (hands_off).
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, data, "utf-8");
  const { rename } = await import("fs/promises");
  await rename(tmp, filePath);
}

// Run the phase-progression check for a single project. Returns
// a DetectionResult describing what was found. Side effects:
// writes the sentinel file + emits the progress event when the
// kind is "ready". Idempotent — if a sentinel already exists for
// the same {from_phase, to_phase}, the file is rewritten with a
// fresh detected_at timestamp but no extra event is emitted.
export async function detectPhaseReady(
  project: ProjectConfig,
): Promise<DetectionResult> {
  if (!roadmapExists(project.id)) {
    return { kind: "no_roadmap" };
  }

  let roadmap;
  try {
    roadmap = await loadRoadmap(project.id);
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }

  let state;
  try {
    state = await loadPhaseState(project.id, roadmap.current_phase);
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }

  const currentPhase = findPhase(roadmap, state.current_phase);
  if (!currentPhase) {
    return {
      kind: "error",
      message: `PHASE_STATE.json current_phase="${state.current_phase}" not in ROADMAP.yaml`,
    };
  }

  const criteriaResults = await evaluateCriteria(currentPhase, project);
  if (!allPassed(criteriaResults)) {
    return {
      kind: "not_ready",
      current_phase: state.current_phase,
      criteria_results: criteriaResults,
    };
  }

  // Criteria pass. Two sub-cases: terminal phase (no next_phase) or
  // non-terminal. Terminal-complete is a real signal — the campaign
  // finished — but there's nothing to advance to, so no sentinel.
  if (!currentPhase.next_phase) {
    return { kind: "terminal_complete", current_phase: state.current_phase };
  }

  const nextPhase = findPhase(roadmap, currentPhase.next_phase);
  if (!nextPhase) {
    return {
      kind: "error",
      message: `next_phase="${currentPhase.next_phase}" not found in ROADMAP.yaml`,
    };
  }

  // Opt-in auto-advance: when the roadmap declares `auto_advance: true`,
  // run executePhaseAdvance directly instead of writing the sentinel.
  // The commander has explicitly delegated authority to the detector.
  if (roadmap.auto_advance === true) {
    // Clear any stale sentinel from a previous session before advancing —
    // executePhaseAdvance's own follow-up may write a fresh one if the
    // NEW current phase is also ready (e.g. instant-pass criteria), but
    // we don't want a sentinel pointing at a phase we just left.
    await clearPhaseReadySentinel(project.id);
    const advance = await executePhaseAdvance(
      project,
      currentPhase,
      nextPhase,
      criteriaResults,
      { forced: false, triggerEvent: "phase_auto_advanced" },
    );
    return {
      kind: "auto_advanced",
      from_phase: advance.from_phase,
      to_phase: advance.to_phase,
      seeded_task_ids: advance.seeded_task_ids,
      criteria_results: criteriaResults,
    };
  }

  // Sentinel path. Skip the event emission if this same readiness was
  // already detected (idempotence — repeated session runs shouldn't
  // spam PROGRESS.jsonl with duplicate phase_ready_for_advance events
  // for the same {from, to} pair).
  const path = phaseReadySentinelPath(project.id);
  let alreadyDetected = false;
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(
        await Bun.file(path).text(),
      ) as PhaseReadySentinel;
      if (
        existing.from_phase === currentPhase.id &&
        existing.to_phase === currentPhase.next_phase
      ) {
        alreadyDetected = true;
      }
    } catch {
      // Corrupted sentinel; treat as not previously detected.
    }
  }

  const sentinel: PhaseReadySentinel = {
    project_id: project.id,
    from_phase: currentPhase.id,
    to_phase: currentPhase.next_phase,
    detected_at: new Date().toISOString(),
    criteria_results: criteriaResults,
  };
  await atomicWrite(path, JSON.stringify(sentinel, null, 2) + "\n");

  if (!alreadyDetected) {
    await appendProgress(project.id, "phase_ready_for_advance", {
      from_phase: currentPhase.id,
      to_phase: currentPhase.next_phase,
      criteria_results: criteriaResults,
    });
  }

  return {
    kind: "ready",
    from_phase: currentPhase.id,
    to_phase: currentPhase.next_phase,
    criteria_results: criteriaResults,
  };
}

// Clear the sentinel after a successful `gs phase advance`. The
// new current_phase has fresh criteria; the next session-start
// detection will re-evaluate and re-write if appropriate.
export async function clearPhaseReadySentinel(projectId: string): Promise<void> {
  const path = phaseReadySentinelPath(projectId);
  if (existsSync(path)) {
    await unlink(path);
  }
}

// Run detection across a fleet at session start. Logs a one-line
// summary per project that has a roadmap. Returns the per-project
// results so the caller (session.ts) can decide whether to surface
// a banner.
export async function runFleetPhaseDetection(
  projects: ProjectConfig[],
  log: (line: string) => void = (line) => console.log(line),
): Promise<Map<string, DetectionResult>> {
  const results = new Map<string, DetectionResult>();
  let readyCount = 0;
  let autoAdvancedCount = 0;
  for (const project of projects) {
    const result = await detectPhaseReady(project);
    results.set(project.id, result);
    if (result.kind === "ready") {
      readyCount++;
      log(
        `[phase] ${project.id}: ready to advance ${result.from_phase} -> ${result.to_phase}`,
      );
    } else if (result.kind === "auto_advanced") {
      autoAdvancedCount++;
      const seeded = result.seeded_task_ids.length;
      log(
        `[phase] ${project.id}: auto-advanced ${result.from_phase} -> ${result.to_phase}` +
          (seeded > 0 ? ` (seeded ${seeded} task${seeded === 1 ? "" : "s"})` : ""),
      );
    } else if (result.kind === "terminal_complete") {
      log(
        `[phase] ${project.id}: terminal phase "${result.current_phase}" criteria all pass (campaign complete)`,
      );
    } else if (result.kind === "error") {
      log(`[phase] ${project.id}: detection error: ${result.message}`);
    }
    // no_roadmap + not_ready stay silent — most projects don't have
    // a ROADMAP.yaml, and not_ready is the normal case for the rest.
  }
  if (readyCount > 0) {
    log(
      `[phase] ${readyCount} project${readyCount === 1 ? "" : "s"} ready to advance — run \`generalstaff phase status --project=<id>\` to inspect.`,
    );
  }
  if (autoAdvancedCount > 0) {
    log(
      `[phase] ${autoAdvancedCount} project${autoAdvancedCount === 1 ? "" : "s"} auto-advanced this session.`,
    );
  }
  return results;
}
