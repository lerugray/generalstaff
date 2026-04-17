// GeneralStaff — projects.yaml loader + validator (build step 4)

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";
import { parse as parseYaml } from "yaml";
import { getRootDir } from "./state";
import { matchesHandsOff } from "./safety";
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
  "git_issues",
  "git_unmerged",
];

const VALID_CONCURRENCY_DETECTION: ConcurrencyDetectionMode[] = [
  "catalogdna",
  "worktree",
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

function requireString(
  projectId: string,
  field: string,
  value: unknown,
): string {
  if (value === undefined || value === null) {
    throw new ProjectValidationError(projectId, field, "is required but missing");
  }
  if (typeof value !== "string") {
    throw new ProjectValidationError(
      projectId,
      field,
      `must be a string, got ${typeof value}`,
    );
  }
  if (value === "") {
    throw new ProjectValidationError(projectId, field, "must not be empty");
  }
  return value;
}

function requirePositiveInt(
  projectId: string,
  field: string,
  value: unknown,
): number {
  if (value === undefined || value === null) {
    throw new ProjectValidationError(projectId, field, "is required but missing");
  }
  if (typeof value !== "number") {
    throw new ProjectValidationError(
      projectId,
      field,
      `must be a number, got ${typeof value}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new ProjectValidationError(
      projectId,
      field,
      `must be an integer, got ${value}`,
    );
  }
  if (value < 1) {
    throw new ProjectValidationError(
      projectId,
      field,
      `must be a positive integer, got ${value}`,
    );
  }
  return value;
}

function validateProject(raw: Record<string, unknown>): ProjectConfig {
  const id = requireString("(unknown)", "id", raw.id);
  const path = requireString(id, "path", raw.path);
  const priority = requirePositiveInt(id, "priority", raw.priority);
  const engineerCommand = requireString(id, "engineer_command", raw.engineer_command);
  const verificationCommand = requireString(
    id,
    "verification_command",
    raw.verification_command,
  );
  const cycleBudget = requirePositiveInt(
    id,
    "cycle_budget_minutes",
    raw.cycle_budget_minutes,
  );

  const workDetection = (raw.work_detection ?? "tasks_json") as WorkDetectionMode;
  if (!VALID_WORK_DETECTION.includes(workDetection)) {
    throw new ProjectValidationError(
      id,
      "work_detection",
      `must be one of: ${VALID_WORK_DETECTION.join(", ")} — got "${workDetection}"`,
    );
  }

  const concurrencyDetection = (raw.concurrency_detection ??
    "none") as ConcurrencyDetectionMode;
  if (!VALID_CONCURRENCY_DETECTION.includes(concurrencyDetection)) {
    throw new ProjectValidationError(
      id,
      "concurrency_detection",
      `must be one of: ${VALID_CONCURRENCY_DETECTION.join(", ")} — got "${concurrencyDetection}"`,
    );
  }

  const branch = (raw.branch ?? "bot/work") as string;
  if (typeof branch !== "string" || branch.trim() === "") {
    throw new ProjectValidationError(
      id,
      "branch",
      "must be a non-empty string if specified",
    );
  }
  const autoMerge = (raw.auto_merge ?? false) as boolean;

  const handsOff = raw.hands_off;
  if (handsOff === undefined || handsOff === null) {
    throw new ProjectValidationError(
      id,
      "hands_off",
      "is required but missing — Hard Rule #5 requires a non-empty hands-off list",
    );
  }
  if (!Array.isArray(handsOff)) {
    throw new ProjectValidationError(
      id,
      "hands_off",
      `must be an array, got ${typeof handsOff}`,
    );
  }
  if (handsOff.length === 0) {
    throw new ProjectValidationError(
      id,
      "hands_off",
      "must not be empty — Hard Rule #5 requires at least one entry",
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

export interface ConfigValidationResult {
  errors: string[];
}

// validateConfig collects ALL configuration errors rather than failing on the
// first one. Errors are formatted with a project-id prefix so the user can
// fix every issue in one pass rather than running the loader repeatedly.
// Path-existence is NOT checked here (machine-specific; use warnProjectPaths).
export function validateConfig(raw: unknown): ConfigValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    errors.push("projects.yaml: root must be an object");
    return { errors };
  }
  const obj = raw as Record<string, unknown>;
  const rawProjects = obj.projects;
  if (!Array.isArray(rawProjects)) {
    errors.push("projects.yaml: must contain a 'projects' array");
    return { errors };
  }
  if (rawProjects.length === 0) {
    errors.push("projects.yaml: must contain at least one project");
    return { errors };
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < rawProjects.length; i++) {
    const p = rawProjects[i];
    if (!p || typeof p !== "object") {
      errors.push(`project[${i}]: must be an object`);
      continue;
    }
    const pr = p as Record<string, unknown>;
    const id =
      typeof pr.id === "string" && pr.id !== ""
        ? pr.id
        : `(unknown-index-${i})`;
    const prefix = `project "${id}"`;

    if (pr.id === undefined || pr.id === null) {
      errors.push(`project[${i}]: id — is required but missing`);
    } else if (typeof pr.id !== "string") {
      errors.push(`project[${i}]: id — must be a string, got ${typeof pr.id}`);
    } else if (pr.id === "") {
      errors.push(`project[${i}]: id — must not be empty`);
    } else if (seenIds.has(pr.id)) {
      errors.push(`Duplicate project id: "${pr.id}"`);
    } else {
      seenIds.add(pr.id);
    }

    if (pr.path === undefined || pr.path === null) {
      errors.push(`${prefix}: path — is required but missing`);
    } else if (typeof pr.path !== "string") {
      errors.push(`${prefix}: path — must be a string, got ${typeof pr.path}`);
    } else if (pr.path === "") {
      errors.push(`${prefix}: path — must not be empty`);
    }

    if (pr.engineer_command === undefined || pr.engineer_command === null) {
      errors.push(`${prefix}: engineer_command — is required but missing`);
    } else if (typeof pr.engineer_command !== "string") {
      errors.push(
        `${prefix}: engineer_command — must be a string, got ${typeof pr.engineer_command}`,
      );
    } else if (pr.engineer_command === "") {
      errors.push(`${prefix}: engineer_command — must not be empty`);
    }

    if (
      pr.verification_command === undefined ||
      pr.verification_command === null
    ) {
      errors.push(`${prefix}: verification_command — is required but missing`);
    } else if (typeof pr.verification_command !== "string") {
      errors.push(
        `${prefix}: verification_command — must be a string, got ${typeof pr.verification_command}`,
      );
    } else if (pr.verification_command === "") {
      errors.push(`${prefix}: verification_command — must not be empty`);
    }

    if (pr.cycle_budget_minutes === undefined || pr.cycle_budget_minutes === null) {
      errors.push(`${prefix}: cycle_budget_minutes — is required but missing`);
    } else if (typeof pr.cycle_budget_minutes !== "number") {
      errors.push(
        `${prefix}: cycle_budget_minutes — must be a number, got ${typeof pr.cycle_budget_minutes}`,
      );
    } else if (!Number.isInteger(pr.cycle_budget_minutes)) {
      errors.push(
        `${prefix}: cycle_budget_minutes — must be an integer, got ${pr.cycle_budget_minutes}`,
      );
    } else if (pr.cycle_budget_minutes <= 0) {
      errors.push(
        `${prefix}: cycle_budget_minutes — must be > 0, got ${pr.cycle_budget_minutes}`,
      );
    }

    if (pr.hands_off === undefined || pr.hands_off === null) {
      errors.push(
        `${prefix}: hands_off — is required but missing — Hard Rule #5 requires a non-empty hands-off list`,
      );
    } else if (!Array.isArray(pr.hands_off)) {
      errors.push(
        `${prefix}: hands_off — must be an array, got ${typeof pr.hands_off}`,
      );
    } else if (pr.hands_off.length === 0) {
      errors.push(
        `${prefix}: hands_off — must not be empty — Hard Rule #5 requires at least one entry`,
      );
    }

    if (pr.branch !== undefined && pr.branch !== null) {
      if (typeof pr.branch !== "string") {
        errors.push(
          `${prefix}: branch — must be a string, got ${typeof pr.branch}`,
        );
      } else if (pr.branch.trim() === "") {
        errors.push(`${prefix}: branch — must be a non-empty string if specified`);
      }
    }
  }

  return { errors };
}

// Throws a single Error whose message lists every issue in the config,
// one per line, with a project-id prefix. Intended for pre-flight
// validation before a session starts so the operator sees every problem
// at once rather than iterating on a fail-first loader.
export function assertValidConfig(raw: unknown): void {
  const { errors } = validateConfig(raw);
  if (errors.length === 0) return;
  const header =
    errors.length === 1
      ? "Invalid projects.yaml:"
      : `Invalid projects.yaml (${errors.length} errors):`;
  const lines = errors.map((e) => `  - ${e}`);
  throw new Error([header, ...lines].join("\n"));
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

function isGitRepo(dirPath: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: dirPath,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5_000,
  });
  return result.status === 0;
}

export type ProjectWarning = {
  projectId: string;
  message: string;
};

export function warnProjectPaths(
  projects: ProjectConfig[],
): ProjectWarning[] {
  const warnings: ProjectWarning[] = [];
  for (const p of projects) {
    if (!existsSync(p.path)) {
      warnings.push({
        projectId: p.id,
        message: `path "${p.path}" does not exist on this machine — skipping git check`,
      });
      continue;
    }
    if (!isGitRepo(p.path)) {
      warnings.push({
        projectId: p.id,
        message: `path "${p.path}" exists but is not a git repository`,
      });
    }
  }
  return warnings;
}

function listGitFiles(dirPath: string): string[] | null {
  const result = spawnSync("git", ["ls-files"], {
    cwd: dirPath,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function validateHandsOff(project: ProjectConfig): ProjectWarning[] {
  const warnings: ProjectWarning[] = [];
  if (!existsSync(project.path)) return warnings;
  if (!isGitRepo(project.path)) return warnings;

  const files = listGitFiles(project.path);
  if (files === null) return warnings;

  for (const pattern of project.hands_off) {
    const matched = files.some((f) => matchesHandsOff(f, [pattern]) !== null);
    if (!matched) {
      warnings.push({
        projectId: project.id,
        message: `hands_off pattern "${pattern}" matches no tracked files — possible typo`,
      });
    }
  }
  return warnings;
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

  // Collect ALL config errors first so the operator sees every issue at
  // once rather than iterating on a fail-first loader.
  assertValidConfig(parsed);

  const rawProjects = parsed.projects as Record<string, unknown>[];
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

  // Validate project paths exist and are git repos (warn only, don't fail)
  const warnings = warnProjectPaths(projects);
  for (const w of warnings) {
    console.warn(`[generalstaff] warning: project "${w.projectId}": ${w.message}`);
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

export class ProjectNotFoundError extends Error {
  constructor(
    public projectId: string,
    public availableIds: string[],
  ) {
    const avail =
      availableIds.length > 0
        ? ` Available: ${availableIds.join(", ")}`
        : " No projects are registered.";
    super(`Project "${projectId}" not found.${avail}`);
    this.name = "ProjectNotFoundError";
  }
}

export function getProject(
  projects: ProjectConfig[],
  projectId: string,
): ProjectConfig {
  const match = projects.find((p) => p.id === projectId);
  if (!match) {
    throw new ProjectNotFoundError(
      projectId,
      projects.map((p) => p.id),
    );
  }
  return match;
}
