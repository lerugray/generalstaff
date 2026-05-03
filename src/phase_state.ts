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
