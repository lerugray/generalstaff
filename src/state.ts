// GeneralStaff — state module (build step 3)
// Atomic file writes, per-project state read/write.
// All paths resolve under state/${project_id}/.

import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, rename, unlink, open } from "fs/promises";
import { randomUUID } from "crypto";
import { join, dirname, resolve } from "path";
import { countRemainingWork } from "./work_detection";
import { isProgressEntry } from "./types";
import type {
  FleetState,
  ProjectState,
  ProjectFleetState,
  CycleOutcome,
  DispatcherConfig,
  ProjectConfig,
} from "./types";

export interface RecentCycle {
  cycle_id: string;
  timestamp: string;
  outcome: string;
  duration_seconds: number | null;
  start_sha: string | null;
  end_sha: string | null;
  reason: string | null;
}

export interface ProjectSummary {
  id: string;
  priority: number;
  state: ProjectFleetState | null;
  project_state: ProjectState;
  remaining_tasks: number;
  recent_cycles: RecentCycle[];
}

export const DEFAULT_RECENT_CYCLES = 5;

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

export function botWorktreePath(project: ProjectConfig): string {
  return join(project.path, ".bot-worktree");
}

export function getStateDir(config?: DispatcherConfig): string {
  const root = getRootDir();
  return config?.state_dir
    ? join(root, config.state_dir)
    : join(root, "state");
}

export function projectStateDir(
  projectId: string,
  config?: DispatcherConfig,
): string {
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

// --- Atomic write: write to collision-free tmp + rename ---

// The temp file lives in the destination directory (same filesystem, so
// the final rename is atomic) and is created with O_EXCL (`wx`) under a
// randomUUID name: creation is exclusive, not merely improbable to
// collide, and an EEXIST simply picks a new name. The temp is unlinked
// on any failure so a failed write leaves nothing behind.
const ATOMIC_WRITE_NAME_ATTEMPTS = 8;

// Serialize replacements of one absolute destination within this process.
// Unique temps alone do not prevent concurrent Windows rename failures.
// This is separate from the fleet read-modify-write queue: fleet updates
// acquire this queue while saving, and atomic writes never acquire that one.
const atomicWriteChains = new Map<string, Promise<void>>();

function atomicWrite(filePath: string, data: string): Promise<void> {
  // Capture cwd before waiting, including for writers queued behind a save.
  const destination = resolve(filePath);
  const prior = atomicWriteChains.get(destination) ?? Promise.resolve();
  const run = prior.then(() => atomicWriteAt(destination, data));
  // A failed write rejects its caller without poisoning queued successors.
  const settled = run.then(() => undefined, () => undefined);
  atomicWriteChains.set(destination, settled);
  void settled.then(() => {
    // An earlier completion must not remove a newer queued writer's tail.
    if (atomicWriteChains.get(destination) === settled) {
      atomicWriteChains.delete(destination);
    }
  });
  return run;
}

async function atomicWriteAt(filePath: string, data: string) {
  ensureDir(dirname(filePath));
  let tmpPath: string | null = null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      const candidate = `${filePath}.${randomUUID()}.tmp`;
      try {
        handle = await open(candidate, "wx");
        tmpPath = candidate;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST" && attempt < ATOMIC_WRITE_NAME_ATTEMPTS) continue;
        throw err;
      }
    }
    // Ownership begins after exclusive creation, before any data is
    // written. A partial write failure still closes/unlinks our temp.
    await handle!.writeFile(data, "utf8");
    await handle!.close();
    handle = undefined;
    await rename(tmpPath, filePath);
    tmpPath = null;
  } finally {
    // Close before unlink so cleanup also works on Windows. Preserve any
    // original write/close/rename error while attempting both cleanups.
    if (handle) await handle.close().catch(() => {});
    if (tmpPath !== null) {
      try {
        await unlink(tmpPath);
      } catch {
        /* best-effort cleanup of orphaned tmp */
      }
    }
  }
}

// --- Fleet state ---

function freshDefaultFleetState(): FleetState {
  // Independent `projects` object every time — shallow-spreading a shared
  // DEFAULT would let concurrent loaders mutate the same map.
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    projects: {},
  };
}

function resolveFleetStatePath(config?: DispatcherConfig, root?: string): string {
  const r = root ?? getRootDir();
  return config?.fleet_state_file
    ? join(r, config.fleet_state_file)
    : join(r, "fleet_state.json");
}

async function loadFleetStateAt(filePath: string): Promise<FleetState> {
  if (!existsSync(filePath)) {
    return freshDefaultFleetState();
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as FleetState;
}

async function saveFleetStateAt(filePath: string, state: FleetState): Promise<void> {
  state.updated_at = new Date().toISOString();
  await atomicWrite(filePath, JSON.stringify(state, null, 2) + "\n");
}

export async function loadFleetState(
  config?: DispatcherConfig,
): Promise<FleetState> {
  return loadFleetStateAt(resolveFleetStatePath(config));
}

export async function saveFleetState(
  state: FleetState,
  config?: DispatcherConfig,
) {
  await saveFleetStateAt(resolveFleetStatePath(config), state);
}

// In-process mutex per resolved fleet file path. Serializes the entire
// read/modify/write so concurrent executeCycle finalizers cannot clobber
// each other's counters via a shared `.tmp` or lost update.
const fleetUpdateChains = new Map<string, Promise<unknown>>();

/**
 * Transactional fleet update: lock the entire load→mutate→save for the
 * fleet file resolved at call time. Waiting callers keep that captured
 * path even if `setRootDir` changes while they are queued. Failure
 * releases the lock; the process-wide root is never modified here.
 */
export async function withFleetStateTransaction<T>(
  mutator: (fleet: FleetState) => T | Promise<T>,
  config?: DispatcherConfig,
): Promise<T> {
  // Capture path at enqueue time so a queued waiter cannot drift if
  // setRootDir changes while prior transactions run.
  const filePath = resolve(resolveFleetStatePath(config, getRootDir()));

  const prior = fleetUpdateChains.get(filePath) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(async () => {
    const fleet = await loadFleetStateAt(filePath);
    const result = await mutator(fleet);
    await saveFleetStateAt(filePath, fleet);
    return result;
  });
  // Keep the chain alive after rejection so the next waiter is not stranded.
  fleetUpdateChains.set(
    filePath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
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
  const [projectState, remaining, recentCycles] = await Promise.all([
    loadProjectState(project.id, config),
    countRemainingWork(project),
    getRecentCycles(project.id, DEFAULT_RECENT_CYCLES, config),
  ]);
  return {
    id: project.id,
    priority: project.priority,
    state: fleet.projects[project.id] ?? null,
    project_state: projectState,
    remaining_tasks: remaining,
    recent_cycles: recentCycles,
  };
}

// Read PROGRESS.jsonl cycle_end events and return the most recent N, newest first.
// Uses a tail-scan so large logs don't fully materialize in memory.
export async function getRecentCycles(
  projectId: string,
  n: number,
  config?: DispatcherConfig,
): Promise<RecentCycle[]> {
  if (n <= 0) return [];
  const filePath = join(projectStateDir(projectId, config), "PROGRESS.jsonl");
  if (!existsSync(filePath)) return [];

  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const result: RecentCycle[] = [];
  for (let i = lines.length - 1; i >= 0 && result.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isProgressEntry(parsed) || parsed.event !== "cycle_end") continue;
    const d = parsed.data;
    result.push({
      cycle_id: parsed.cycle_id ?? "",
      timestamp: parsed.timestamp,
      outcome: typeof d.outcome === "string" ? d.outcome : "?",
      duration_seconds: typeof d.duration_seconds === "number" ? d.duration_seconds : null,
      start_sha: typeof d.start_sha === "string" ? d.start_sha : null,
      end_sha: typeof d.end_sha === "string" ? d.end_sha : null,
      reason: typeof d.reason === "string" ? d.reason : null,
    });
  }
  return result;
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
