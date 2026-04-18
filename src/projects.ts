// GeneralStaff — projects.yaml loader + validator (build step 4)

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  parseDocument,
  LineCounter,
  YAMLParseError,
  isMap,
  isSeq,
  isScalar,
  type Document,
} from "yaml";
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
  // gs-186: Phase 4 default is sequential (1 slot). Opt into parallel
  // cycles by setting dispatcher.max_parallel_slots: N in projects.yaml.
  max_parallel_slots: 1,
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

// Source information passed alongside a parsed config so error messages can
// cite the exact `projects.yaml line X:` where each issue originates and
// offer a concrete "Likely cause / Fix" hint. Optional — the raw-JS call
// path (validateConfig with no source) still works for callers that already
// hold a plain object.
export interface ConfigSource {
  doc: Document;
  lineCounter: LineCounter;
}

// Project id char set — lowercase alphanumeric plus hyphen/underscore.
// Must start with an alphanumeric so ids can be used as filesystem
// fragments (state/<id>/) without shell-escape surprises.
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function locateProjectLine(
  source: ConfigSource | undefined,
  index: number,
): number | undefined {
  if (!source) return undefined;
  const contents = source.doc.contents;
  if (!contents || !isMap(contents)) return undefined;
  const projectsPair = contents.items.find(
    (p) => isScalar(p.key) && p.key.value === "projects",
  );
  if (!projectsPair || !projectsPair.value || !isSeq(projectsPair.value)) {
    return undefined;
  }
  const item = projectsPair.value.items[index];
  const range = (item as { range?: [number, number, number] } | undefined)?.range;
  if (!range) return undefined;
  return source.lineCounter.linePos(range[0]).line;
}

function locateFieldLine(
  source: ConfigSource | undefined,
  projectIndex: number,
  field: string,
): number | undefined {
  if (!source) return undefined;
  const contents = source.doc.contents;
  if (!contents || !isMap(contents)) return undefined;
  const projectsPair = contents.items.find(
    (p) => isScalar(p.key) && p.key.value === "projects",
  );
  if (!projectsPair || !projectsPair.value || !isSeq(projectsPair.value)) {
    return undefined;
  }
  const project = projectsPair.value.items[projectIndex];
  if (!project || !isMap(project)) return undefined;
  const pair = project.items.find(
    (p) => isScalar(p.key) && p.key.value === field,
  );
  if (!pair) return undefined;
  const node = (pair.value ?? pair.key) as
    | { range?: [number, number, number] }
    | undefined;
  if (!node?.range) return undefined;
  return source.lineCounter.linePos(node.range[0]).line;
}

function formatLine(
  line: number | undefined,
  body: string,
  hint?: string,
  fix?: string,
): string {
  const parts: string[] = [];
  if (line !== undefined) parts.push(`projects.yaml line ${line}:`);
  parts.push(body);
  if (hint) parts.push(`Likely cause: ${hint}.`);
  if (fix) parts.push(`Fix: ${fix}.`);
  return parts.join(" ");
}

// validateConfig collects ALL configuration errors rather than failing on the
// first one. Errors are formatted with a project-id prefix so the user can
// fix every issue in one pass rather than running the loader repeatedly.
// Path-existence is NOT checked here (machine-specific; use warnProjectPaths).
// When a ConfigSource is supplied, error messages additionally cite the
// source line number and include a "Likely cause / Fix" suggestion.
export function validateConfig(
  raw: unknown,
  source?: ConfigSource,
): ConfigValidationResult {
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
    const projectLine = locateProjectLine(source, i);
    if (!p || typeof p !== "object") {
      errors.push(
        formatLine(
          projectLine,
          `project[${i}]: must be an object`,
          "entry is a scalar or null",
          "replace with a YAML mapping of project fields",
        ),
      );
      continue;
    }
    const pr = p as Record<string, unknown>;
    const id =
      typeof pr.id === "string" && pr.id !== ""
        ? pr.id
        : `(unknown-index-${i})`;
    const prefix = `project "${id}"`;

    const idLine = locateFieldLine(source, i, "id") ?? projectLine;
    if (pr.id === undefined || pr.id === null) {
      errors.push(
        formatLine(
          projectLine,
          `project[${i}]: id — is required but missing`,
          "project entry has no id: field",
          'add an id: line as the first field, e.g. `id: my-project`',
        ),
      );
    } else if (typeof pr.id !== "string") {
      errors.push(
        formatLine(
          idLine,
          `project[${i}]: id — must be a string, got ${typeof pr.id}`,
          "id was given as a non-string scalar",
          "quote the id or use a plain string like `id: my-project`",
        ),
      );
    } else if (pr.id === "") {
      errors.push(
        formatLine(
          idLine,
          `project[${i}]: id — must not be empty`,
          "id field is present but the value is blank",
          "pick a short lowercase id, e.g. `id: my-project`",
        ),
      );
    } else if (!VALID_ID_RE.test(pr.id)) {
      errors.push(
        formatLine(
          idLine,
          `project[${i}]: id — "${pr.id}" has invalid chars (must match [a-z0-9][a-z0-9_-]*)`,
          "id contains uppercase, spaces, punctuation, or starts with a non-alphanumeric",
          "rename to lowercase ASCII letters/digits with `-` or `_`, e.g. `my-project`",
        ),
      );
    } else if (seenIds.has(pr.id)) {
      errors.push(
        formatLine(
          idLine,
          `Duplicate project id: "${pr.id}"`,
          "the same id appears on two project entries",
          "rename one entry — ids must be unique across projects:",
        ),
      );
    } else {
      seenIds.add(pr.id);
    }

    const pathLine = locateFieldLine(source, i, "path") ?? projectLine;
    if (pr.path === undefined || pr.path === null) {
      errors.push(
        formatLine(
          projectLine,
          `${prefix}: path — is required but missing`,
          "project has no path: field",
          "add `path: /absolute/path/to/project` pointing at the managed repo",
        ),
      );
    } else if (typeof pr.path !== "string") {
      errors.push(
        formatLine(
          pathLine,
          `${prefix}: path — must be a string, got ${typeof pr.path}`,
          "path was given as a list or mapping",
          "replace with a single absolute path string",
        ),
      );
    } else if (pr.path === "") {
      errors.push(
        formatLine(
          pathLine,
          `${prefix}: path — must not be empty`,
          "path: field is present but blank",
          "fill in an absolute path to the project root",
        ),
      );
    }

    const engLine = locateFieldLine(source, i, "engineer_command") ?? projectLine;
    if (pr.engineer_command === undefined || pr.engineer_command === null) {
      errors.push(
        formatLine(
          projectLine,
          `${prefix}: engineer_command — is required but missing`,
          "project has no engineer_command: field",
          "add `engineer_command: \"bash run_bot.sh ${cycle_budget_minutes}\"` or similar",
        ),
      );
    } else if (typeof pr.engineer_command !== "string") {
      errors.push(
        formatLine(
          engLine,
          `${prefix}: engineer_command — must be a string, got ${typeof pr.engineer_command}`,
          "engineer_command was a list/map, not a shell-command string",
          "replace with a single-line quoted string",
        ),
      );
    } else if (pr.engineer_command === "") {
      errors.push(
        formatLine(
          engLine,
          `${prefix}: engineer_command — must not be empty`,
          "engineer_command: is blank",
          "supply the command the dispatcher should run each cycle",
        ),
      );
    }

    const verLine =
      locateFieldLine(source, i, "verification_command") ?? projectLine;
    if (
      pr.verification_command === undefined ||
      pr.verification_command === null
    ) {
      errors.push(
        formatLine(
          projectLine,
          `${prefix}: verification_command — is required but missing`,
          "project has no verification_command: field",
          "add a test command, e.g. `verification_command: \"bun test && bun x tsc --noEmit\"`",
        ),
      );
    } else if (typeof pr.verification_command !== "string") {
      errors.push(
        formatLine(
          verLine,
          `${prefix}: verification_command — must be a string, got ${typeof pr.verification_command}`,
          "verification_command was given as a list/map",
          "replace with a single-line quoted shell command",
        ),
      );
    } else if (pr.verification_command === "") {
      errors.push(
        formatLine(
          verLine,
          `${prefix}: verification_command — must not be empty`,
          "verification_command: is blank",
          "supply the command that runs the test suite and typechecker",
        ),
      );
    }

    const cbLine =
      locateFieldLine(source, i, "cycle_budget_minutes") ?? projectLine;
    if (pr.cycle_budget_minutes === undefined || pr.cycle_budget_minutes === null) {
      errors.push(
        formatLine(
          projectLine,
          `${prefix}: cycle_budget_minutes — is required but missing`,
          "project has no cycle_budget_minutes: field",
          "add `cycle_budget_minutes: 30` (a positive integer)",
        ),
      );
    } else if (typeof pr.cycle_budget_minutes !== "number") {
      errors.push(
        formatLine(
          cbLine,
          `${prefix}: cycle_budget_minutes — must be a number, got ${typeof pr.cycle_budget_minutes}`,
          "value was quoted or given as a non-number",
          "remove quotes — YAML treats `30` as a number, `\"30\"` as a string",
        ),
      );
    } else if (!Number.isInteger(pr.cycle_budget_minutes)) {
      errors.push(
        formatLine(
          cbLine,
          `${prefix}: cycle_budget_minutes — must be an integer, got ${pr.cycle_budget_minutes}`,
          "fractional minutes aren't meaningful for cycle budgets",
          "round to a whole number of minutes",
        ),
      );
    } else if (pr.cycle_budget_minutes <= 0) {
      errors.push(
        formatLine(
          cbLine,
          `${prefix}: cycle_budget_minutes — must be > 0, got ${pr.cycle_budget_minutes}`,
          "zero or negative cycle budget leaves the bot no time to work",
          "set a positive integer (typical: 15–45 minutes)",
        ),
      );
    }

    const hoLine = locateFieldLine(source, i, "hands_off") ?? projectLine;
    if (pr.hands_off === undefined || pr.hands_off === null) {
      errors.push(
        formatLine(
          projectLine,
          `${prefix}: hands_off — is required but missing — Hard Rule #5 requires a non-empty hands-off list`,
          "project declared without any hands-off protection",
          "add a `hands_off:` list naming paths the bot must never touch (CLAUDE.md, design docs, secrets)",
        ),
      );
    } else if (!Array.isArray(pr.hands_off)) {
      errors.push(
        formatLine(
          hoLine,
          `${prefix}: hands_off — must be an array, got ${typeof pr.hands_off}`,
          "hands_off was given as a scalar/map instead of a list",
          "use YAML list form: `hands_off:\\n  - secret/\\n  - CLAUDE.md`",
        ),
      );
    } else if (pr.hands_off.length === 0) {
      errors.push(
        formatLine(
          hoLine,
          `${prefix}: hands_off — must not be empty — Hard Rule #5 requires at least one entry`,
          "hands_off was set to [] which defeats the protection",
          "add at least one glob pattern like `CLAUDE.md` or `src/safety.ts`",
        ),
      );
    } else {
      // Per-entry sanity checks. An entry that isn't a string, is empty, is
      // an absolute path, or contains a `..` traversal is almost certainly a
      // typo — matchesHandsOff globbing will silently fail to match at
      // cycle time, which is exactly the kind of bug Hard Rule #5 exists to
      // prevent.
      for (let j = 0; j < pr.hands_off.length; j++) {
        const entry = pr.hands_off[j];
        const entryLine = hoLine; // list items share the outer field's line
        if (typeof entry !== "string") {
          errors.push(
            formatLine(
              entryLine,
              `${prefix}: hands_off[${j}] — must be a string, got ${typeof entry}`,
              "list contains a non-string entry (null, number, or map)",
              "replace with a glob pattern string",
            ),
          );
        } else if (entry === "" || entry.trim() === "") {
          errors.push(
            formatLine(
              entryLine,
              `${prefix}: hands_off[${j}] — entry must not be empty or whitespace`,
              "an empty string matches nothing",
              "remove the empty entry or replace it with a real glob pattern",
            ),
          );
        } else if (
          entry.startsWith("/") ||
          /^[A-Za-z]:[\\/]/.test(entry)
        ) {
          errors.push(
            formatLine(
              entryLine,
              `${prefix}: hands_off[${j}] — "${entry}" looks like an absolute path, expected a repo-relative glob`,
              "hands-off patterns are matched against repo-relative paths",
              "drop the leading slash or drive letter, e.g. use `src/safety.ts` not `/src/safety.ts`",
            ),
          );
        } else if (entry.includes("..")) {
          errors.push(
            formatLine(
              entryLine,
              `${prefix}: hands_off[${j}] — "${entry}" contains \`..\` traversal`,
              "parent-directory traversals don't make sense for repo-scoped patterns",
              "remove the `..` — hands-off paths are already repo-root-relative",
            ),
          );
        }
      }
    }

    const brLine = locateFieldLine(source, i, "branch") ?? projectLine;
    if (pr.branch !== undefined && pr.branch !== null) {
      if (typeof pr.branch !== "string") {
        errors.push(
          formatLine(
            brLine,
            `${prefix}: branch — must be a string, got ${typeof pr.branch}`,
            "branch was given as a non-string value",
            "set `branch: bot/work` or omit the field to use the default",
          ),
        );
      } else if (pr.branch.trim() === "") {
        errors.push(
          formatLine(
            brLine,
            `${prefix}: branch — must be a non-empty string if specified`,
            "branch: is present but blank",
            "remove the line to accept the `bot/work` default, or name a real branch",
          ),
        );
      }
    }
  }

  return { errors };
}

// Throws a single Error whose message lists every issue in the config,
// one per line, with a project-id prefix. Intended for pre-flight
// validation before a session starts so the operator sees every problem
// at once rather than iterating on a fail-first loader.
export function assertValidConfig(raw: unknown, source?: ConfigSource): void {
  const { errors } = validateConfig(raw, source);
  if (errors.length === 0) return;
  const header =
    errors.length === 1
      ? "Invalid projects.yaml:"
      : `Invalid projects.yaml (${errors.length} errors):`;
  const lines = errors.map((e) => `  - ${e}`);
  throw new Error([header, ...lines].join("\n"));
}

// Convert a YAMLParseError (from `yaml`'s Document.errors) into a single
// operator-friendly message in our standard "projects.yaml line X:" format.
// Message picks a hint tailored to the error code when we have one, and
// falls back to a generic indentation/colons hint otherwise.
function formatParseError(err: YAMLParseError): string {
  const line = err.linePos?.[0]?.line;
  // YAML's own message often includes a "at line X, column Y" suffix —
  // strip it so our "projects.yaml line X:" prefix doesn't duplicate.
  const core = err.message
    .replace(/\s*at line \d+, column \d+:?[\s\S]*$/i, "")
    .trim();
  const hints: Record<string, { hint: string; fix: string }> = {
    BAD_INDENT: {
      hint: "indentation is inconsistent with the surrounding block",
      fix: "use the same number of leading spaces as sibling keys (no tabs)",
    },
    TAB_AS_INDENT: {
      hint: "YAML forbids tabs as indentation",
      fix: "replace the leading tab(s) with spaces",
    },
    MISSING_CHAR: {
      hint: "a required character (usually `:` or `-`) is missing",
      fix: "add the missing colon after a mapping key, or `-` before a list item",
    },
    UNEXPECTED_TOKEN: {
      hint: "an unexpected character or token appeared where a key or value was expected",
      fix: "check for stray quotes, misplaced `-`, or a missing blank line",
    },
    BAD_SCALAR_START: {
      hint: "value starts with a reserved YAML character (`@`, `` ` ``, etc.)",
      fix: "quote the value, e.g. `field: \"@something\"`",
    },
    DUPLICATE_KEY: {
      hint: "the same key appears twice in the same mapping",
      fix: "remove the duplicate or rename one of the keys",
    },
    BLOCK_AS_IMPLICIT_KEY: {
      hint: "a block-style value was used where a single-line key is required",
      fix: "put the value on the same line as the key, or quote the whole key",
    },
  };
  const h = hints[err.code] ?? {
    hint: `YAML syntax error (${err.code})`,
    fix: "check indentation, missing colons, and unquoted special characters around this line",
  };
  return formatLine(line, core, h.hint, h.fix);
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
    max_parallel_slots: normalizeParallelSlots(raw.max_parallel_slots),
  };
}

// gs-186: accept numeric input, clamp to >=1. Invalid / missing values
// fall back to the default (sequential). Large values are kept as-is —
// the operator is BYOK-paying for their own spend and knows their
// compute; we don't second-guess the ceiling.
function normalizeParallelSlots(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DISPATCHER_DEFAULTS.max_parallel_slots;
  }
  const n = Math.floor(raw);
  return n < 1 ? 1 : n;
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

  // parseDocument + LineCounter gives us per-node source positions so
  // validation errors can cite `projects.yaml line X:`. Parse errors
  // themselves are collected on `doc.errors` rather than thrown, so we
  // can batch-reformat them in our standard format before surfacing.
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter });
  if (doc.errors.length > 0) {
    const messages = doc.errors.map((e) => formatParseError(e));
    const header =
      messages.length === 1
        ? "Invalid projects.yaml:"
        : `Invalid projects.yaml (${messages.length} errors):`;
    const lines = messages.map((m) => `  - ${m}`);
    throw new Error([header, ...lines].join("\n"));
  }
  const parsed = doc.toJS() as Record<string, unknown>;

  // Collect ALL config errors first so the operator sees every issue at
  // once rather than iterating on a fail-first loader.
  assertValidConfig(parsed, { doc, lineCounter });

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
