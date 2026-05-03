// GeneralStaff — phase-ready view module (Phase B v1).
//
// Lists projects with a PHASE_READY.json sentinel — i.e., projects
// whose current phase has all criteria passing AND a non-terminal
// next_phase, awaiting commander approval to advance via
// `gs phase advance`. Pure data — no rendering. The dashboard
// Attention panel can render this view.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadProjects } from "../projects";
import { getRootDir } from "../state";
import type { PhaseReadySentinel } from "../types";

export interface PhaseReadyProjectRow {
  project_id: string;
  from_phase: string;
  to_phase: string;
  detected_at: string;
  detected_age_seconds: number;
  passed_criteria: number;
  total_criteria: number;
}

export interface PhaseReadyData {
  ready: PhaseReadyProjectRow[];
  total_projects_scanned: number;
  total_with_roadmap: number;
  rendered_at: string;
}

function sentinelPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "PHASE_READY.json");
}

function roadmapPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "ROADMAP.yaml");
}

export async function getPhaseReady(): Promise<PhaseReadyData> {
  const projects = await loadProjects();
  const now = Date.now();
  const ready: PhaseReadyProjectRow[] = [];
  let withRoadmap = 0;

  for (const project of projects) {
    if (existsSync(roadmapPath(project.id))) {
      withRoadmap++;
    }
    const path = sentinelPath(project.id);
    if (!existsSync(path)) continue;
    let sentinel: PhaseReadySentinel;
    try {
      sentinel = JSON.parse(await readFile(path, "utf-8")) as PhaseReadySentinel;
    } catch {
      // Skip corrupted sentinels — the next session-start detection
      // will rewrite them if criteria still pass.
      continue;
    }
    const detectedMs = Date.parse(sentinel.detected_at);
    const ageSeconds = isNaN(detectedMs)
      ? 0
      : Math.max(0, Math.floor((now - detectedMs) / 1000));
    const passed = sentinel.criteria_results.filter((c) => c.passed).length;
    ready.push({
      project_id: sentinel.project_id,
      from_phase: sentinel.from_phase,
      to_phase: sentinel.to_phase,
      detected_at: sentinel.detected_at,
      detected_age_seconds: ageSeconds,
      passed_criteria: passed,
      total_criteria: sentinel.criteria_results.length,
    });
  }

  // Sort by oldest-detected first — projects sitting longest with
  // an unadvanced phase should bubble up.
  ready.sort((a, b) => b.detected_age_seconds - a.detected_age_seconds);

  return {
    ready,
    total_projects_scanned: projects.length,
    total_with_roadmap: withRoadmap,
    rendered_at: new Date().toISOString(),
  };
}
