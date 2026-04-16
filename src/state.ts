// GeneralStaff — state module (build step 3)
// Atomic file writes, per-project state read/write.
// All paths resolve under state/${project_id}/.

import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, rename, unlink } from "fs/promises";
import { join, dirname } from "path";
import { countRemainingWork } from "./work_detection";
import type {
  FleetState,
  ProjectState,
  ProjectFleetState,
  CycleOutcome,
  DispatcherConfig,
  ProjectConfig,
} from "./types";

export interface ProjectSummary {
  id: string;
  priority: number;
  state: ProjectFleetState | null;
  project_state: ProjectState;
  remaining_tasks: number;
}

let _rootDir: string | null = null;

export function setRootDir(dir: string) {
  _rootDir = dir;
}

export function getRootDir(): string {
  if (!_rootDir) {
    _rootDir = process.cwd();
  }
  return _rootDir;
}

function getStateDir(config?: DispatcherConfig): string {
  const root = getRootDir();
  return config?.state_dir
    ? join(root, config.state_dir)
    : join(root, "state");
}

function projectStateDir(projectId: string, config?: DispatcherConfig): string {
  return join(getStateDir(config), projectId);
}

export function cycleDir(
  projectId: string,
  cycleId: string,
  config?: DispatcherConfig,
): string {
  return join(projectStateDir(projectId, config), "cycles", cycleId);
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// --- Atomic write: write to tmp + rename ---

async function atomicWrite(filePath: string, data: string) {
  ensureDir(dirname(filePath));
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, data, "utf8");
  await rename(tmpPath, filePath);
}

// --- Fleet state ---

const DEFAULT_FLEET_STATE: FleetState = {
  version: 1,
  updated_at: new Date().toISOString(),
  projects: {},
};

export async function loadFleetState(
  config?: DispatcherConfig,
): Promise<FleetState> {
  const root = getRootDir();
  const filePath = config?.fleet_state_file
    ? join(root, config.fleet_state_file)
    : join(root, "fleet_state.json");

  if (!existsSync(filePath)) {
    return { ...DEFAULT_FLEET_STATE, updated_at: new Date().toISOString() };
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as FleetState;
}

export async function saveFleetState(
  state: FleetState,
  config?: DispatcherConfig,
) {
  const root = getRootDir();
  const filePath = config?.fleet_state_file
    ? join(root, config.fleet_state_file)
    : join(root, "fleet_state.json");

  state.updated_at = new Date().toISOString();
  await atomicWrite(filePath, JSON.stringify(state, null, 2) + "\n");
}

export function getProjectFleetState(
  fleet: FleetState,
  projectId: string,
): ProjectFleetState {
  return (
    fleet.projects[projectId] ?? {
      last_cycle_at: null,
      last_cycle_outcome: null,
      total_cycles: 0,
      total_verified: 0,
      total_failed: 0,
      accumulated_minutes: 0,
    }
  );
}

export function updateProjectFleetState(
  fleet: FleetState,
  projectId: string,
  outcome: CycleOutcome,
  durationMinutes: number,
): FleetState {
  const current = getProjectFleetState(fleet, projectId);
  fleet.projects[projectId] = {
    last_cycle_at: new Date().toISOString(),
    last_cycle_outcome: outcome,
    total_cycles: current.total_cycles + 1,
    total_verified:
      current.total_verified +
      (outcome === "verified" || outcome === "verified_weak" ? 1 : 0),
    total_failed:
      current.total_failed + (outcome === "verification_failed" ? 1 : 0),
    accumulated_minutes: current.accumulated_minutes + durationMinutes,
  };
  return fleet;
}

// --- Per-project state ---

export async function loadProjectState(
  projectId: string,
  config?: DispatcherConfig,
): Promise<ProjectState> {
  const filePath = join(projectStateDir(projectId, config), "STATE.json");
  if (!existsSync(filePath)) {
    return {
      project_id: projectId,
      current_cycle_id: null,
      last_cycle_id: null,
      last_cycle_outcome: null,
      last_cycle_at: null,
      cycles_this_session: 0,
    };
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as ProjectState;
}

export async function saveProjectState(
  state: ProjectState,
  config?: DispatcherConfig,
) {
  const filePath = join(
    projectStateDir(state.project_id, config),
    "STATE.json",
  );
  await atomicWrite(filePath, JSON.stringify(state, null, 2) + "\n");
}

export async function getProjectSummary(
  project: ProjectConfig,
  fleet: FleetState,
  config?: DispatcherConfig,
): Promise<ProjectSummary> {
  const [projectState, remaining] = await Promise.all([
    loadProjectState(project.id, config),
    countRemainingWork(project),
  ]);
  return {
    id: project.id,
    priority: project.priority,
    state: fleet.projects[project.id] ?? null,
    project_state: projectState,
    remaining_tasks: remaining,
  };
}

// --- Cycle directory setup ---

export function ensureCycleDir(
  projectId: string,
  cycleId: string,
  config?: DispatcherConfig,
): string {
  const dir = cycleDir(projectId, cycleId, config);
  ensureDir(dir);
  return dir;
}

// --- Generic file helpers for state dir ---

export async function writeStateFile(
  projectId: string,
  filename: string,
  content: string,
  config?: DispatcherConfig,
) {
  const filePath = join(projectStateDir(projectId, config), filename);
  await atomicWrite(filePath, content);
}

export async function readStateFile(
  projectId: string,
  filename: string,
  config?: DispatcherConfig,
): Promise<string | null> {
  const filePath = join(projectStateDir(projectId, config), filename);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf8");
}

// --- Cycle artifact helpers ---

export async function writeCycleFile(
  projectId: string,
  cycleId: string,
  filename: string,
  content: string,
  config?: DispatcherConfig,
) {
  const dir = ensureCycleDir(projectId, cycleId, config);
  await writeFile(join(dir, filename), content, "utf8");
}

export async function readCycleFile(
  projectId: string,
  cycleId: string,
  filename: string,
  config?: DispatcherConfig,
): Promise<string | null> {
  const filePath = join(
    cycleDir(projectId, cycleId, config),
    filename,
  );
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf8");
}
