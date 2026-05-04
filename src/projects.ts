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
  EngineerProvider,
  SessionBudget,
  BudgetEnforcement,
  BudgetProviderSource,
  BudgetOnExhausted,
} from "./types";
import {
  VALID_ENGINEER_PROVIDERS,
  VALID_BUDGET_ENFORCEMENTS,
  VALID_BUDGET_PROVIDER_SOURCES,
  VALID_BUDGET_ON_EXHAUSTED,
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
  // gs-292: empty-diff / all-empty-round session stop guard.
  max_consecutive_empty: 3,
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

// gs-297: Validate a session_budget block. Used for both the fleet-wide
// dispatcher scope (scope = "dispatcher") and per-project scopes (scope =
// project id). Returns undefined when the block is absent; throws a
// ProjectValidationError on any shape problem so callers don't need to
// branch on undefined vs invalid. Enforces "exactly one unit" and
// rejects impossible values (non-positive, non-finite, fractional for
// cycles/tokens). Cross-scope rules (per-project ≤ fleet-wide) are
// handled separately in validateBudgetHierarchy after both scopes have
// been parsed.
function validateSessionBudget(
  scope: string,
  raw: unknown,
): SessionBudget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProjectValidationError(
      scope,
      "session_budget",
      `must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const o = raw as Record<string, unknown>;
  const budget: SessionBudget = {};

  const unitKeys = ["max_usd", "max_tokens", "max_cycles"] as const;
  const setUnits: string[] = [];
  for (const key of unitKeys) {
    const value = o[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number") {
      throw new ProjectValidationError(
        scope,
        `session_budget.${key}`,
        `must be a number, got ${typeof value}`,
      );
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new ProjectValidationError(
        scope,
        `session_budget.${key}`,
        `must be a positive finite number, got ${value}`,
      );
    }
    // Fractional dollars are meaningful for cost caps; fractional
    // tokens and cycles are not.
    if ((key === "max_tokens" || key === "max_cycles") && !Number.isInteger(value)) {
      throw new ProjectValidationError(
        scope,
        `session_budget.${key}`,
        `must be an integer, got ${value}`,
      );
    }
    budget[key] = value;
    setUnits.push(key);
  }
  if (setUnits.length > 1) {
    throw new ProjectValidationError(
      scope,
      "session_budget",
      `exactly one of max_usd / max_tokens / max_cycles may be set — got ${setUnits.join(" and ")}`,
    );
  }

  if (o.enforcement !== undefined && o.enforcement !== null) {
    if (typeof o.enforcement !== "string") {
      throw new ProjectValidationError(
        scope,
        "session_budget.enforcement",
        `must be a string, got ${typeof o.enforcement}`,
      );
    }
    if (!VALID_BUDGET_ENFORCEMENTS.includes(o.enforcement as BudgetEnforcement)) {
      throw new ProjectValidationError(
        scope,
        "session_budget.enforcement",
        `must be one of: ${VALID_BUDGET_ENFORCEMENTS.join(", ")} — got "${o.enforcement}"`,
      );
    }
    budget.enforcement = o.enforcement as BudgetEnforcement;
  }

  if (o.provider_source !== undefined && o.provider_source !== null) {
    if (typeof o.provider_source !== "string") {
      throw new ProjectValidationError(
        scope,
        "session_budget.provider_source",
        `must be a string, got ${typeof o.provider_source}`,
      );
    }
    if (
      !VALID_BUDGET_PROVIDER_SOURCES.includes(
        o.provider_source as BudgetProviderSource,
      )
    ) {
      throw new ProjectValidationError(
        scope,
        "session_budget.provider_source",
        `must be one of: ${VALID_BUDGET_PROVIDER_SOURCES.join(", ")} — got "${o.provider_source}"`,
      );
    }
    budget.provider_source = o.provider_source as BudgetProviderSource;
  }

  if (o.on_exhausted !== undefined && o.on_exhausted !== null) {
    // Only meaningful on per-project caps. Fleet-wide cap hit
    // inherently ends the session (no surviving scope to fall back
    // to), so on_exhausted on the dispatcher block is a config
    // mistake — reject rather than silently ignore.
    if (scope === "dispatcher") {
      throw new ProjectValidationError(
        scope,
        "session_budget.on_exhausted",
        "is only valid on per-project session_budget blocks — fleet-wide cap hits always end the session",
      );
    }
    if (typeof o.on_exhausted !== "string") {
      throw new ProjectValidationError(
        scope,
        "session_budget.on_exhausted",
        `must be a string, got ${typeof o.on_exhausted}`,
      );
    }
    if (
      !VALID_BUDGET_ON_EXHAUSTED.includes(
        o.on_exhausted as BudgetOnExhausted,
      )
    ) {
      throw new ProjectValidationError(
        scope,
        "session_budget.on_exhausted",
        `must be one of: ${VALID_BUDGET_ON_EXHAUSTED.join(", ")} — got "${o.on_exhausted}"`,
      );
    }
    budget.on_exhausted = o.on_exhausted as BudgetOnExhausted;
  }

  return budget;
}

// gs-297: Cross-scope invariant — any per-project cap with the same
// unit as a fleet-wide cap must be ≤ the fleet-wide value. Setting a
// per-project cap HIGHER than the fleet cap is almost certainly a
// config mistake: the tighter fleet cap still binds, so the project
// value would be silently dead. Fail at load time so the operator
// fixes the intent rather than finding out at runtime.
function validateBudgetHierarchy(
  dispatcher: DispatcherConfig,
  projects: ProjectConfig[],
): void {
  const fleet = dispatcher.session_budget;
  if (!fleet) return;
  const unitKeys = ["max_usd", "max_tokens", "max_cycles"] as const;
  for (const p of projects) {
    const proj = p.session_budget;
    if (!proj) continue;
    for (const key of unitKeys) {
      const fleetVal = fleet[key];
      const projVal = proj[key];
      if (fleetVal !== undefined && projVal !== undefined && projVal > fleetVal) {
        throw new ProjectValidationError(
          p.id,
          `session_budget.${key}`,
          `per-project value ${projVal} exceeds fleet-wide value ${fleetVal} — per-project budgets must fit within the fleet cap`,
        );
      }
    }
  }
}

/** Integer >= 1. Used for dispatcher + optional project fields (gs-292). */
function parseMin1PositiveInt(
  scopeId: string,
  field: string,
  value: unknown,
): number {
  if (typeof value !== "number") {
    throw new ProjectValidationError(
      scopeId,
      field,
      `must be a number, got ${typeof value}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new ProjectValidationError(
      scopeId,
      field,
      `must be an integer, got ${value}`,
    );
  }
  if (value < 1) {
    throw new ProjectValidationError(
      scopeId,
      field,
      `must be >= 1, got ${value}`,
    );
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

  // gs-270: optional engineer_provider + engineer_model (Phase 7 engineer
  // swap). Unset preserves claude behavior. If set, must be one of the
  // registered providers; engineer_model is a free-form string the
  // provider module interprets.
  let engineerProvider: EngineerProvider | undefined;
  if (raw.engineer_provider !== undefined && raw.engineer_provider !== null) {
    if (typeof raw.engineer_provider !== "string") {
      throw new ProjectValidationError(
        id,
        "engineer_provider",
        `must be a string, got ${typeof raw.engineer_provider}`,
      );
    }
    if (!VALID_ENGINEER_PROVIDERS.includes(raw.engineer_provider as EngineerProvider)) {
      throw new ProjectValidationError(
        id,
        "engineer_provider",
        `must be one of: ${VALID_ENGINEER_PROVIDERS.join(", ")} — got "${raw.engineer_provider}"`,
      );
    }
    engineerProvider = raw.engineer_provider as EngineerProvider;
  }
  let engineerModel: string | undefined;
  if (raw.engineer_model !== undefined && raw.engineer_model !== null) {
    if (typeof raw.engineer_model !== "string") {
      throw new ProjectValidationError(
        id,
        "engineer_model",
        `must be a string, got ${typeof raw.engineer_model}`,
      );
    }
    if (raw.engineer_model === "") {
      throw new ProjectValidationError(
        id,
        "engineer_model",
        "must not be empty if specified — omit the field to use the provider default",
      );
    }
    engineerModel = raw.engineer_model;
  }

  // gs-278: creative-work opt-in (Hard Rule #1 carve-out). Off by
  // default; projects that want to accept creative tasks must
  // explicitly opt in. See docs/internal/RULE-RELAXATION-2026-04-20.md
  // for the policy context.
  let creativeWorkAllowed: boolean | undefined;
  if (raw.creative_work_allowed !== undefined && raw.creative_work_allowed !== null) {
    if (typeof raw.creative_work_allowed !== "boolean") {
      throw new ProjectValidationError(
        id,
        "creative_work_allowed",
        `must be a boolean, got ${typeof raw.creative_work_allowed}`,
      );
    }
    creativeWorkAllowed = raw.creative_work_allowed;
  }
  let creativeWorkBranch: string | undefined;
  if (raw.creative_work_branch !== undefined && raw.creative_work_branch !== null) {
    if (typeof raw.creative_work_branch !== "string" || raw.creative_work_branch.trim() === "") {
      throw new ProjectValidationError(
        id,
        "creative_work_branch",
        "must be a non-empty string if specified",
      );
    }
    creativeWorkBranch = raw.creative_work_branch;
  }
  let creativeWorkDraftsDir: string | undefined;
  if (raw.creative_work_drafts_dir !== undefined && raw.creative_work_drafts_dir !== null) {
    if (typeof raw.creative_work_drafts_dir !== "string" || raw.creative_work_drafts_dir.trim() === "") {
      throw new ProjectValidationError(
        id,
        "creative_work_drafts_dir",
        "must be a non-empty string if specified",
      );
    }
    creativeWorkDraftsDir = raw.creative_work_drafts_dir;
  }
  let voiceReferencePaths: string[] | undefined;
  if (raw.voice_reference_paths !== undefined && raw.voice_reference_paths !== null) {
    if (!Array.isArray(raw.voice_reference_paths)) {
      throw new ProjectValidationError(
        id,
        "voice_reference_paths",
        `must be an array, got ${typeof raw.voice_reference_paths}`,
      );
    }
    for (let j = 0; j < raw.voice_reference_paths.length; j++) {
      const entry = raw.voice_reference_paths[j];
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new ProjectValidationError(
          id,
          "voice_reference_paths",
          `entry [${j}] must be a non-empty string, got ${JSON.stringify(entry)}`,
        );
      }
    }
    voiceReferencePaths = raw.voice_reference_paths as string[];
  }

  // gs-297: per-project usage-budget override. Validated here; the
  // cross-scope invariant (per-project ≤ fleet-wide) is checked in
  // validateBudgetHierarchy after both scopes are parsed.
  const sessionBudget = validateSessionBudget(id, raw.session_budget);

  // gs-306: mission-swarm reviewer-preview integration config.
  let missionswarm: { default_audience: string; n_agents?: number; n_rounds?: number } | undefined;
  if (raw.missionswarm !== undefined && raw.missionswarm !== null) {
    if (typeof raw.missionswarm !== "object" || Array.isArray(raw.missionswarm)) {
      throw new ProjectValidationError(
        id,
        "missionswarm",
        `must be an object, got ${Array.isArray(raw.missionswarm) ? "array" : typeof raw.missionswarm}`,
      );
    }
    const ms = raw.missionswarm as Record<string, unknown>;
    if (typeof ms.default_audience !== "string" || ms.default_audience.trim() === "") {
      throw new ProjectValidationError(
        id,
        "missionswarm.default_audience",
        "must be a non-empty string",
      );
    }
    let nAgents: number | undefined;
    if (ms.n_agents !== undefined && ms.n_agents !== null) {
      if (typeof ms.n_agents !== "number" || !Number.isInteger(ms.n_agents) || ms.n_agents < 1) {
        throw new ProjectValidationError(
          id,
          "missionswarm.n_agents",
          `must be a positive integer if specified, got ${JSON.stringify(ms.n_agents)}`,
        );
      }
      nAgents = ms.n_agents;
    }
    let nRounds: number | undefined;
    if (ms.n_rounds !== undefined && ms.n_rounds !== null) {
      if (typeof ms.n_rounds !== "number" || !Number.isInteger(ms.n_rounds) || ms.n_rounds < 1) {
        throw new ProjectValidationError(
          id,
          "missionswarm.n_rounds",
          `must be a positive integer if specified, got ${JSON.stringify(ms.n_rounds)}`,
        );
      }
      nRounds = ms.n_rounds;
    }
    missionswarm = {
      default_audience: ms.default_audience,
      n_agents: nAgents,
      n_rounds: nRounds,
    };
  }

  // gs-315: customer-facing flag. Boolean only — the heuristic for
  // "does this diff touch customer-reachable surfaces" lives in the
  // reviewer model itself. Schema validation only.
  let publicFacing: boolean | undefined;
  if (raw.public_facing !== undefined && raw.public_facing !== null) {
    if (typeof raw.public_facing !== "boolean") {
      throw new ProjectValidationError(
        id,
        "public_facing",
        `must be a boolean if specified, got ${typeof raw.public_facing}`,
      );
    }
    publicFacing = raw.public_facing;
  }

  // Phase B+ followup: lifecycle stage. Drives the `lifecycle_transition`
  // phase-completion criterion + future dev/live dashboard split.
  // Optional; absent reads as "dev". Strict enum so a typo like
  // `lifecycle: "alive"` fails loudly at config load instead of
  // silently never matching the criterion.
  let lifecycle: "dev" | "live" | undefined;
  if (raw.lifecycle !== undefined && raw.lifecycle !== null) {
    if (raw.lifecycle !== "dev" && raw.lifecycle !== "live") {
      throw new ProjectValidationError(
        id,
        "lifecycle",
        `must be "dev" or "live" if specified, got ${JSON.stringify(raw.lifecycle)}`,
      );
    }
    lifecycle = raw.lifecycle;
  }

  // gs-292: optional empty-diff streak override (per-project).
  let maxConsecutiveEmpty: number | undefined;
  if (raw.max_consecutive_empty !== undefined && raw.max_consecutive_empty !== null) {
    maxConsecutiveEmpty = parseMin1PositiveInt(
      id,
      "max_consecutive_empty",
      raw.max_consecutive_empty,
    );
  }

  // gs-311: optional journal-source config. Inert until jr-003 lands;
  // schema-only today so projects.yaml can start carrying the path.
  let journal:
    | {
        mission_bullet_root: string;
        scan_days?: number;
        reviewer_context?: boolean;
        affinity_aliases?: string[];
      }
    | undefined;
  if (raw.journal !== undefined && raw.journal !== null) {
    if (typeof raw.journal !== "object" || Array.isArray(raw.journal)) {
      throw new ProjectValidationError(
        id,
        "journal",
        `must be an object, got ${Array.isArray(raw.journal) ? "array" : typeof raw.journal}`,
      );
    }
    const j = raw.journal as Record<string, unknown>;
    if (typeof j.mission_bullet_root !== "string" || j.mission_bullet_root.trim() === "") {
      throw new ProjectValidationError(
        id,
        "journal.mission_bullet_root",
        "must be a non-empty string",
      );
    }
    let scanDays: number | undefined;
    if (j.scan_days !== undefined && j.scan_days !== null) {
      if (typeof j.scan_days !== "number" || !Number.isInteger(j.scan_days) || j.scan_days < 1) {
        throw new ProjectValidationError(
          id,
          "journal.scan_days",
          `must be a positive integer if specified, got ${JSON.stringify(j.scan_days)}`,
        );
      }
      scanDays = j.scan_days;
    }
    let reviewerContext: boolean | undefined;
    if (j.reviewer_context !== undefined && j.reviewer_context !== null) {
      if (typeof j.reviewer_context !== "boolean") {
        throw new ProjectValidationError(
          id,
          "journal.reviewer_context",
          `must be a boolean if specified, got ${typeof j.reviewer_context}`,
        );
      }
      reviewerContext = j.reviewer_context;
    }
    let affinityAliases: string[] | undefined;
    if (j.affinity_aliases !== undefined && j.affinity_aliases !== null) {
      if (!Array.isArray(j.affinity_aliases)) {
        throw new ProjectValidationError(
          id,
          "journal.affinity_aliases",
          `must be an array of strings if specified, got ${typeof j.affinity_aliases}`,
        );
      }
      const aliases: string[] = [];
      for (let i = 0; i < j.affinity_aliases.length; i++) {
        const el = j.affinity_aliases[i];
        if (typeof el !== "string" || el.trim() === "") {
          throw new ProjectValidationError(
            id,
            "journal.affinity_aliases",
            `each element must be a non-empty string, got ${JSON.stringify(el)} at index ${i}`,
          );
        }
        aliases.push(el);
      }
      affinityAliases = aliases;
    }
    journal = {
      mission_bullet_root: j.mission_bullet_root,
      scan_days: scanDays,
      reviewer_context: reviewerContext,
      affinity_aliases: affinityAliases,
    };
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
    engineer_provider: engineerProvider,
    engineer_model: engineerModel,
    creative_work_allowed: creativeWorkAllowed,
    creative_work_branch: creativeWorkBranch,
    creative_work_drafts_dir: creativeWorkDraftsDir,
    voice_reference_paths: voiceReferencePaths,
    session_budget: sessionBudget,
    missionswarm,
    journal,
    public_facing: publicFacing,
    lifecycle,
    max_consecutive_empty: maxConsecutiveEmpty,
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

    const mceLine = locateFieldLine(source, i, "max_consecutive_empty") ?? projectLine;
    if (pr.max_consecutive_empty !== undefined && pr.max_consecutive_empty !== null) {
      if (typeof pr.max_consecutive_empty !== "number") {
        errors.push(
          formatLine(
            mceLine,
            `${prefix}: max_consecutive_empty — must be a number, got ${typeof pr.max_consecutive_empty}`,
            "value was quoted or given as a non-number",
            "remove quotes so YAML parses it as an integer",
          ),
        );
      } else if (!Number.isInteger(pr.max_consecutive_empty)) {
        errors.push(
          formatLine(
            mceLine,
            `${prefix}: max_consecutive_empty — must be an integer, got ${pr.max_consecutive_empty}`,
            "fractional values are not meaningful for a streak count",
            "round to a whole number >= 1",
          ),
        );
      } else if (pr.max_consecutive_empty < 1) {
        errors.push(
          formatLine(
            mceLine,
            `${prefix}: max_consecutive_empty — must be >= 1, got ${pr.max_consecutive_empty}`,
            "zero or negative cannot end a streak that never increments",
            "set a positive integer or omit the field for the fleet default",
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

  // gs-297: fleet-wide usage budget. Unlike other dispatcher fields,
  // which silently fall back to defaults on bad input, session_budget
  // validation throws — a misconfigured budget could silently allow
  // unbounded spend (Hard Rule 8 / BYOK), which is exactly the foot-gun
  // the feature exists to prevent.
  const sessionBudget = validateSessionBudget("dispatcher", raw.session_budget);

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
    max_consecutive_empty: dispatcherMaxConsecutiveEmpty(raw),
    session_budget: sessionBudget,
  };
}

function dispatcherMaxConsecutiveEmpty(raw: Record<string, unknown>): number {
  const v = raw.max_consecutive_empty;
  if (v === undefined || v === null) {
    return DISPATCHER_DEFAULTS.max_consecutive_empty;
  }
  return parseMin1PositiveInt("dispatcher", "max_consecutive_empty", v);
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

// Raised when projects.yaml isn't at the expected path. Typed so CLI
// handlers can catch it and print a clean message instead of the
// Bun stack trace that a generic Error produces for first-run users
// (who have cloned but not yet copied projects.yaml.example).
export class ProjectsYamlNotFoundError extends Error {
  constructor(public filePath: string) {
    super(
      `projects.yaml not found at ${filePath}. Copy projects.yaml.example and fill in your paths.`,
    );
    this.name = "ProjectsYamlNotFoundError";
  }
}

export async function loadProjectsYaml(
  yamlPath?: string,
): Promise<ProjectsYaml> {
  const filePath = yamlPath ?? join(getRootDir(), "projects.yaml");
  if (!existsSync(filePath)) {
    throw new ProjectsYamlNotFoundError(filePath);
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

  // gs-297: cross-scope budget invariant must be checked after both
  // dispatcher and projects are parsed.
  validateBudgetHierarchy(dispatcher, projects);

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
