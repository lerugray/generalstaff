// GeneralStaff — phase state tracker (Phase A v1)
// FUTURE-DIRECTIONS-2026-04-19 §8.
//
// Tracks per-project phase progression in `state/<project>/PHASE_STATE.json`.
// The runtime view that ROADMAP.yaml itself doesn't carry: which phases
// have been marked complete, when, and the criteria-results that gated
// the advance. Atomic writes via state.ts conventions.

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { getRootDir } from "./state";
import type { PhaseState, PhaseStateEntry } from "./types";

export function phaseStatePath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "PHASE_STATE.json");
}

// Writes are atomic via the same temp-rename pattern used in state.ts.
// Kept inline rather than imported because state.ts's atomicWrite is
// not exported and duplicating the 3-line helper is cheaper than
// adding an export to state.ts (state.ts is hands_off).
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, data, "utf-8");
  // rename is atomic on POSIX; on Windows it's atomic if dest doesn't
  // exist or is on the same volume, which is the case for state files.
  const { rename } = await import("fs/promises");
  await rename(tmp, filePath);
}

// Returns the phase state for a project, creating an in-memory default
// (no completed phases) if the file doesn't exist yet. The default is
// NOT persisted until savePhaseState is called.
export async function loadPhaseState(
  projectId: string,
  defaultCurrentPhase: string,
): Promise<PhaseState> {
  const path = phaseStatePath(projectId);
  if (!existsSync(path)) {
    return {
      project_id: projectId,
      current_phase: defaultCurrentPhase,
      completed_phases: [],
    };
  }
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  return validatePhaseState(parsed, projectId);
}

function validatePhaseState(raw: unknown, expectedProjectId: string): PhaseState {
  if (raw == null || typeof raw !== "object") {
    throw new Error("PHASE_STATE.json must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.project_id !== "string") {
    throw new Error("PHASE_STATE.json missing string `project_id`");
  }
  if (o.project_id !== expectedProjectId) {
    throw new Error(
      `PHASE_STATE.json project_id="${o.project_id}" does not match registry id "${expectedProjectId}"`,
    );
  }
  if (typeof o.current_phase !== "string") {
    throw new Error("PHASE_STATE.json missing string `current_phase`");
  }
  if (!Array.isArray(o.completed_phases)) {
    throw new Error("PHASE_STATE.json `completed_phases` must be a list");
  }
  // We trust the shape of completed_phases at the type level rather
  // than deep-validating each entry. The file is dispatcher-written,
  // not user-written; corruption would be a bug, not user input.
  return {
    project_id: o.project_id,
    current_phase: o.current_phase,
    completed_phases: o.completed_phases as PhaseStateEntry[],
  };
}

export async function savePhaseState(state: PhaseState): Promise<void> {
  const path = phaseStatePath(state.project_id);
  await atomicWrite(path, JSON.stringify(state, null, 2) + "\n");
}

// Mutate-and-save helper for the common case: phase advanced.
// Records the completed phase + flips current_phase to the next one.
export async function recordPhaseAdvance(
  projectId: string,
  fromPhase: string,
  toPhase: string,
  criteriaResults: PhaseStateEntry["criteria_results"],
): Promise<PhaseState> {
  const state = await loadPhaseState(projectId, fromPhase);
  state.completed_phases.push({
    phase_id: fromPhase,
    completed_at: new Date().toISOString(),
    criteria_results: criteriaResults,
  });
  state.current_phase = toPhase;
  await savePhaseState(state);
  return state;
}

export interface PhaseRollbackResult {
  from_phase: string;
  to_phase: string;
  // The phase IDs that were popped off completed_phases (= the phases
  // we walked back THROUGH). Empty when forced=true and the target
  // wasn't in completed_phases.
  undone_phases: string[];
  forced: boolean;
}

// Roll the project back to a target phase. Two cases:
// (a) target IS in completed_phases — pop entries until target is at
//     the top of the stack, then promote target to current_phase.
//     undone_phases records the popped IDs.
// (b) target is NOT in completed_phases — only allowed with forced=true
//     (the caller has explicit operator intent). Sets current_phase
//     directly without touching completed_phases. undone_phases empty.
//
// Note: rollback does NOT remove already-seeded tasks from tasks.json.
// Tasks that were materialized from a phase's `tasks:` literals stay
// in the queue; the commander decides whether to manually mark them
// done/skipped. Removing them automatically would conflict with the
// "tasks may have been edited / depended on" reality.
export async function recordPhaseRollback(
  projectId: string,
  defaultCurrentPhase: string,
  targetPhase: string,
  options: { forced?: boolean } = {},
): Promise<PhaseRollbackResult> {
  const forced = options.forced ?? false;
  const state = await loadPhaseState(projectId, defaultCurrentPhase);
  const fromPhase = state.current_phase;

  if (fromPhase === targetPhase) {
    return {
      from_phase: fromPhase,
      to_phase: targetPhase,
      undone_phases: [],
      forced,
    };
  }

  const targetIdx = state.completed_phases.findIndex(
    (e) => e.phase_id === targetPhase,
  );

  if (targetIdx === -1) {
    if (!forced) {
      throw new Error(
        `Cannot rollback ${projectId} to "${targetPhase}": phase not in completed_phases. ` +
          `Use --force to set current_phase directly without walking back through history.`,
      );
    }
    // Forced rollback to a phase we've never been on (or that we
    // somehow lost from history). Set current_phase directly; do not
    // touch completed_phases.
    state.current_phase = targetPhase;
    await savePhaseState(state);
    return {
      from_phase: fromPhase,
      to_phase: targetPhase,
      undone_phases: [],
      forced,
    };
  }

  // Walk back: undo all phases AFTER the target index. The target
  // itself stays in completed_phases — we're rolling INTO target,
  // meaning target is "current" again, but its prior completion
  // record is preserved as historical fact.
  const undonePhases = state.completed_phases
    .slice(targetIdx + 1)
    .map((e) => e.phase_id);
  // Also undo the target's own entry, since rolling back to a phase
  // means we're re-opening it as current — its prior completion record
  // is no longer meaningful for "current state". The audit log keeps
  // the trail (phase_complete + phase_rolled_back events).
  undonePhases.push(state.completed_phases[targetIdx]!.phase_id);
  state.completed_phases = state.completed_phases.slice(0, targetIdx);
  state.current_phase = targetPhase;

  await savePhaseState(state);
  return {
    from_phase: fromPhase,
    to_phase: targetPhase,
    undone_phases: undonePhases,
    forced,
  };
}
