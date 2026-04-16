// GeneralStaff — projects.yaml loader + validator (build step 4)

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { getRootDir } from "./state";
import type {
  ProjectConfig,
  DispatcherConfig,
  ProjectsYaml,
  WorkDetectionMode,
  ConcurrencyDetectionMode,
} from "./types";

const VALID_WORK_DETECTION: WorkDetectionMode[] = [
  "catalogdna_bot_tasks",
  "tasks_json",
];

const VALID_CONCURRENCY_DETECTION: ConcurrencyDetectionMode[] = [
  "catalogdna",
  "none",
];

const DISPATCHER_DEFAULTS: DispatcherConfig = {
  state_dir: "./state",
  fleet_state_file: "./fleet_state.json",
  stop_file: "./STOP",
  override_file: "./next_project.txt",
  picker: "priority_x_staleness",
  max_cycles_per_project_per_session: 3,
  log_dir: "./logs",
  digest_dir: "./digests",
};

export class ProjectValidationError extends Error {
  constructor(
    public projectId: string,
    public field: string,
    message: string,
  ) {
    super(`Project "${projectId}": ${field} — ${message}`);
    this.name = "ProjectValidationError";
  }
}

function validateProject(raw: Record<string, unknown>): ProjectConfig {
  const id = raw.id as string;
  if (!id || typeof id !== "string") {
    throw new ProjectValidationError("(unknown)", "id", "must be a non-empty string");
  }

  const path = raw.path as string;
  if (!path || typeof path !== "string") {
    throw new ProjectValidationError(id, "path", "must be a non-empty string");
  }

  const priority = raw.priority as number;
  if (typeof priority !== "number" || priority < 1 || !Number.isInteger(priority)) {
    throw new ProjectValidationError(id, "priority", "must be a positive integer");
  }

  const engineerCommand = raw.engineer_command as string;
  if (!engineerCommand || typeof engineerCommand !== "string") {
    throw new ProjectValidationError(id, "engineer_command", "must be a non-empty string");
  }

  const verificationCommand = raw.verification_command as string;
  if (!verificationCommand || typeof verificationCommand !== "string") {
    throw new ProjectValidationError(
      id,
      "verification_command",
      "must be a non-empty string",
    );
  }

  const cycleBudget = raw.cycle_budget_minutes as number;
  if (
    typeof cycleBudget !== "number" ||
    cycleBudget <= 0 ||
    !Number.isInteger(cycleBudget)
  ) {
    throw new ProjectValidationError(
      id,
      "cycle_budget_minutes",
      "must be a positive integer",
    );
  }

  const workDetection = (raw.work_detection ?? "tasks_json") as WorkDetectionMode;
  if (!VALID_WORK_DETECTION.includes(workDetection)) {
    throw new ProjectValidationError(
      id,
      "work_detection",
      `must be one of: ${VALID_WORK_DETECTION.join(", ")}`,
    );
  }

  const concurrencyDetection = (raw.concurrency_detection ??
    "none") as ConcurrencyDetectionMode;
  if (!VALID_CONCURRENCY_DETECTION.includes(concurrencyDetection)) {
    throw new ProjectValidationError(
      id,
      "concurrency_detection",
      `must be one of: ${VALID_CONCURRENCY_DETECTION.join(", ")}`,
    );
  }

  const branch = (raw.branch ?? "bot/work") as string;
  const autoMerge = (raw.auto_merge ?? false) as boolean;

  const handsOff = raw.hands_off as string[] | undefined;
  if (!Array.isArray(handsOff) || handsOff.length === 0) {
    throw new ProjectValidationError(
      id,
      "hands_off",
      "must be a non-empty array — Hard Rule #5",
    );
  }

  return {
    id,
    path,
    priority,
    engineer_command: engineerCommand,
    verification_command: verificationCommand,
    cycle_budget_minutes: cycleBudget,
    work_detection: workDetection,
    concurrency_detection: concurrencyDetection,
    branch,
    auto_merge: autoMerge,
    hands_off: handsOff,
    notes: raw.notes as string | undefined,
  };
}

function validateDispatcher(
  raw: Record<string, unknown> | undefined,
): DispatcherConfig {
  if (!raw) return { ...DISPATCHER_DEFAULTS };

  return {
    state_dir: (raw.state_dir as string) ?? DISPATCHER_DEFAULTS.state_dir,
    fleet_state_file:
      (raw.fleet_state_file as string) ?? DISPATCHER_DEFAULTS.fleet_state_file,
    stop_file: (raw.stop_file as string) ?? DISPATCHER_DEFAULTS.stop_file,
    override_file:
      (raw.override_file as string) ?? DISPATCHER_DEFAULTS.override_file,
    picker: (raw.picker as string) ?? DISPATCHER_DEFAULTS.picker,
    max_cycles_per_project_per_session:
      (raw.max_cycles_per_project_per_session as number) ??
      DISPATCHER_DEFAULTS.max_cycles_per_project_per_session,
    log_dir: (raw.log_dir as string) ?? DISPATCHER_DEFAULTS.log_dir,
    digest_dir: (raw.digest_dir as string) ?? DISPATCHER_DEFAULTS.digest_dir,
  };
}

export async function loadProjectsYaml(
  yamlPath?: string,
): Promise<ProjectsYaml> {
  const filePath = yamlPath ?? join(getRootDir(), "projects.yaml");
  if (!existsSync(filePath)) {
    throw new Error(
      `projects.yaml not found at ${filePath}. Copy projects.yaml.example and fill in your paths.`,
    );
  }

  const raw = await readFile(filePath, "utf8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  const rawProjects = parsed.projects as Record<string, unknown>[];
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    throw new Error("projects.yaml must contain at least one project");
  }

  const projects = rawProjects.map(validateProject);
  const dispatcher = validateDispatcher(
    parsed.dispatcher as Record<string, unknown> | undefined,
  );

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const p of projects) {
    if (ids.has(p.id)) {
      throw new Error(`Duplicate project id: "${p.id}"`);
    }
    ids.add(p.id);
  }

  return { projects, dispatcher };
}

export async function loadProjects(yamlPath?: string): Promise<ProjectConfig[]> {
  const yaml = await loadProjectsYaml(yamlPath);
  return yaml.projects;
}

export async function loadDispatcherConfig(
  yamlPath?: string,
): Promise<DispatcherConfig> {
  const yaml = await loadProjectsYaml(yamlPath);
  return yaml.dispatcher;
}

export function findProject(
  projects: ProjectConfig[],
  projectId: string,
): ProjectConfig | undefined {
  return projects.find((p) => p.id === projectId);
}
