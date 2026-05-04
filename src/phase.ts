// GeneralStaff — phased roadmap module (Phase A v1)
// FUTURE-DIRECTIONS-2026-04-19 §8 first-cut scope.
//
// Reads `state/<project>/ROADMAP.yaml`, validates the schema,
// evaluates phase completion criteria. Does NOT integrate with
// the dispatcher loop (that's Phase B). v1 supports
// `all_tasks_done` + `custom_check` criteria only.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import {
  type Roadmap,
  type RoadmapPhase,
  type RoadmapCriterion,
  type RoadmapLiteralTask,
  type PhaseCriterionResult,
} from "./types";
import { getRootDir } from "./state";
import { loadTasks, addTask } from "./tasks";
import type { ProjectConfig } from "./types";
import { recordPhaseAdvance } from "./phase_state";
import { appendProgress } from "./audit";

export class RoadmapLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapLoadError";
  }
}

export class RoadmapValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapValidationError";
  }
}

export function roadmapPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "ROADMAP.yaml");
}

export function roadmapExists(projectId: string): boolean {
  return existsSync(roadmapPath(projectId));
}

export async function loadRoadmap(projectId: string): Promise<Roadmap> {
  const path = roadmapPath(projectId);
  if (!existsSync(path)) {
    throw new RoadmapLoadError(
      `ROADMAP.yaml not found at ${path}. Run \`generalstaff phase init ${projectId}\` to scaffold one.`,
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new RoadmapLoadError(
      `Failed to read ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new RoadmapLoadError(
      `Failed to parse ${path} as YAML: ${(err as Error).message}`,
    );
  }
  return validateRoadmap(parsed, projectId);
}

// Schema validator. Throws RoadmapValidationError on any structural
// issue; otherwise returns a typed Roadmap. Catches the obvious
// shape errors (missing fields, wrong types, dangling next_phase
// references) at parse time so the dispatcher / CLI never has to.
export function validateRoadmap(raw: unknown, expectedProjectId: string): Roadmap {
  if (raw == null || typeof raw !== "object") {
    throw new RoadmapValidationError("ROADMAP.yaml must be a YAML mapping at the top level");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.project_id !== "string" || o.project_id.length === 0) {
    throw new RoadmapValidationError("ROADMAP.yaml must declare `project_id: <string>`");
  }
  if (o.project_id !== expectedProjectId) {
    throw new RoadmapValidationError(
      `ROADMAP.yaml project_id="${o.project_id}" does not match registry id "${expectedProjectId}"`,
    );
  }
  if (typeof o.current_phase !== "string" || o.current_phase.length === 0) {
    throw new RoadmapValidationError("ROADMAP.yaml must declare `current_phase: <string>`");
  }
  if (!Array.isArray(o.phases) || o.phases.length === 0) {
    throw new RoadmapValidationError("ROADMAP.yaml must declare a non-empty `phases:` list");
  }

  const phases: RoadmapPhase[] = o.phases.map((p, i) => validatePhase(p, i));
  const ids = new Set(phases.map((p) => p.id));
  if (ids.size !== phases.length) {
    throw new RoadmapValidationError("Duplicate phase ids in `phases:` list");
  }
  if (!ids.has(o.current_phase)) {
    throw new RoadmapValidationError(
      `current_phase="${o.current_phase}" does not match any declared phase id`,
    );
  }
  for (const p of phases) {
    if (p.next_phase != null && !ids.has(p.next_phase)) {
      throw new RoadmapValidationError(
        `Phase "${p.id}" declares next_phase="${p.next_phase}" but no such phase exists`,
      );
    }
    if (p.depends_on != null && !ids.has(p.depends_on)) {
      throw new RoadmapValidationError(
        `Phase "${p.id}" declares depends_on="${p.depends_on}" but no such phase exists`,
      );
    }
  }
  let autoAdvance: boolean | undefined;
  if (o.auto_advance != null) {
    if (typeof o.auto_advance !== "boolean") {
      throw new RoadmapValidationError(
        "ROADMAP.yaml `auto_advance` must be a boolean (true/false) when set",
      );
    }
    autoAdvance = o.auto_advance;
  }

  return {
    project_id: o.project_id,
    current_phase: o.current_phase,
    phases,
    auto_advance: autoAdvance,
  };
}

function validatePhase(raw: unknown, idx: number): RoadmapPhase {
  if (raw == null || typeof raw !== "object") {
    throw new RoadmapValidationError(`phases[${idx}] is not a mapping`);
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0) {
    throw new RoadmapValidationError(`phases[${idx}].id is required and must be a string`);
  }
  if (typeof p.goal !== "string" || p.goal.length === 0) {
    throw new RoadmapValidationError(`phases[${idx}].goal is required and must be a string`);
  }
  if (!Array.isArray(p.completion_criteria)) {
    throw new RoadmapValidationError(
      `phases[${idx}].completion_criteria must be a list (use "[]" for none)`,
    );
  }
  const criteria: RoadmapCriterion[] = p.completion_criteria.map((c, j) =>
    validateCriterion(c, idx, j),
  );

  let tasks: RoadmapPhase["tasks"];
  if (p.tasks != null) {
    tasks = parseTaskList(p.tasks, `phases[${idx}].tasks`);
  }

  let tasksTemplate: RoadmapPhase["tasks_template"];
  if (p.tasks_template != null) {
    tasksTemplate = parseTaskList(
      p.tasks_template,
      `phases[${idx}].tasks_template`,
    );
    // Validate placeholders early so a malformed template doesn't
    // surface only at advance time.
    for (let j = 0; j < tasksTemplate.length; j++) {
      validateTaskTemplatePlaceholders(
        tasksTemplate[j]!,
        `phases[${idx}].tasks_template[${j}]`,
      );
    }
  }

  return {
    id: p.id,
    goal: p.goal,
    depends_on: typeof p.depends_on === "string" ? p.depends_on : undefined,
    tasks,
    tasks_template: tasksTemplate,
    completion_criteria: criteria,
    next_phase: typeof p.next_phase === "string" ? p.next_phase : undefined,
  };
}

// Shared parser for both `tasks:` and `tasks_template:`. Both lists
// have the same shape; tasks_template entries' string fields may
// additionally contain {placeholder} tokens that get resolved at
// advance time via expandTaskTemplates().
function parseTaskList(raw: unknown, label: string): RoadmapLiteralTask[] {
  if (!Array.isArray(raw)) {
    throw new RoadmapValidationError(`${label} must be a list`);
  }
  return raw.map((t, j) => {
    if (t == null || typeof t !== "object") {
      throw new RoadmapValidationError(`${label}[${j}] is not a mapping`);
    }
    const task = t as Record<string, unknown>;
    if (typeof task.title !== "string" || task.title.length === 0) {
      throw new RoadmapValidationError(
        `${label}[${j}].title is required and must be a string`,
      );
    }
    return {
      title: task.title,
      priority: typeof task.priority === "number" ? task.priority : undefined,
      interactive_only:
        typeof task.interactive_only === "boolean" ? task.interactive_only : undefined,
      interactive_only_reason:
        typeof task.interactive_only_reason === "string"
          ? task.interactive_only_reason
          : undefined,
      expected_touches: Array.isArray(task.expected_touches)
        ? (task.expected_touches.filter((x) => typeof x === "string") as string[])
        : undefined,
    };
  });
}

// Supported placeholder tokens in tasks_template strings. Adding a
// new placeholder requires (a) adding it here, (b) populating it in
// expandTaskTemplates' context, (c) updating docs/conventions/roadmap.md.
const SUPPORTED_PLACEHOLDERS: readonly string[] = [
  "phase_id",
  "prev_phase",
  "project_id",
  "date",
  "datetime",
];

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

// Walk every string-typed field on a template task, find {placeholder}
// tokens, and reject any token that isn't in SUPPORTED_PLACEHOLDERS.
// This catches typos at load time rather than silently passing them
// through to the materialized task.
function validateTaskTemplatePlaceholders(
  task: RoadmapLiteralTask,
  label: string,
): void {
  const fields: Array<[string, string | undefined]> = [
    ["title", task.title],
    ["interactive_only_reason", task.interactive_only_reason],
  ];
  for (const [fieldName, value] of fields) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      const token = match[1]!;
      if (!SUPPORTED_PLACEHOLDERS.includes(token)) {
        throw new RoadmapValidationError(
          `${label}.${fieldName} uses unknown placeholder "{${token}}". ` +
            `Supported: ${SUPPORTED_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.`,
        );
      }
    }
  }
  if (Array.isArray(task.expected_touches)) {
    for (let i = 0; i < task.expected_touches.length; i++) {
      const value = task.expected_touches[i]!;
      for (const match of value.matchAll(PLACEHOLDER_RE)) {
        const token = match[1]!;
        if (!SUPPORTED_PLACEHOLDERS.includes(token)) {
          throw new RoadmapValidationError(
            `${label}.expected_touches[${i}] uses unknown placeholder "{${token}}". ` +
              `Supported: ${SUPPORTED_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.`,
          );
        }
      }
    }
  }
}

export interface TemplateExpansionContext {
  phase_id: string;
  prev_phase: string;
  project_id: string;
  // Date in ISO 8601 YYYY-MM-DD form (UTC).
  date: string;
  // Full ISO 8601 timestamp YYYY-MM-DDTHH:MM:SSZ (UTC).
  datetime: string;
}

export function buildExpansionContext(
  projectId: string,
  prevPhase: string,
  newPhase: string,
  now: Date = new Date(),
): TemplateExpansionContext {
  const datetime = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const date = datetime.slice(0, 10);
  return {
    phase_id: newPhase,
    prev_phase: prevPhase,
    project_id: projectId,
    date,
    datetime,
  };
}

function applyPlaceholders(
  value: string,
  ctx: TemplateExpansionContext,
): string {
  return value.replace(PLACEHOLDER_RE, (full, token: string) => {
    if (token in ctx) {
      return (ctx as unknown as Record<string, string>)[token]!;
    }
    // validateTaskTemplatePlaceholders rejects unknown tokens at load
    // time, so this branch is defensive-only. If we reach it, leave
    // the literal token in place rather than silently dropping it.
    return full;
  });
}

export function expandTaskTemplates(
  templates: RoadmapLiteralTask[],
  ctx: TemplateExpansionContext,
): RoadmapLiteralTask[] {
  return templates.map((t) => ({
    title: applyPlaceholders(t.title, ctx),
    priority: t.priority,
    interactive_only: t.interactive_only,
    interactive_only_reason:
      t.interactive_only_reason != null
        ? applyPlaceholders(t.interactive_only_reason, ctx)
        : undefined,
    expected_touches: t.expected_touches?.map((p) => applyPlaceholders(p, ctx)),
  }));
}

function validateCriterion(raw: unknown, phaseIdx: number, critIdx: number): RoadmapCriterion {
  if (raw == null || typeof raw !== "object") {
    throw new RoadmapValidationError(
      `phases[${phaseIdx}].completion_criteria[${critIdx}] is not a mapping`,
    );
  }
  const c = raw as Record<string, unknown>;
  const keys = Object.keys(c);
  if (keys.length !== 1) {
    throw new RoadmapValidationError(
      `phases[${phaseIdx}].completion_criteria[${critIdx}] must declare exactly one criterion key, got ${keys.length}: [${keys.join(", ")}]`,
    );
  }
  const key = keys[0]!;
  const value = c[key];
  switch (key) {
    case "all_tasks_done":
      if (value !== true) {
        throw new RoadmapValidationError(
          `phases[${phaseIdx}].completion_criteria[${critIdx}].all_tasks_done must be \`true\``,
        );
      }
      return { all_tasks_done: true };
    case "custom_check":
      if (typeof value !== "string" || value.length === 0) {
        throw new RoadmapValidationError(
          `phases[${phaseIdx}].completion_criteria[${critIdx}].custom_check must be a non-empty string`,
        );
      }
      return { custom_check: value };
    case "launch_gate":
      if (typeof value !== "string" || value.length === 0) {
        throw new RoadmapValidationError(
          `phases[${phaseIdx}].completion_criteria[${critIdx}].launch_gate must be a non-empty string`,
        );
      }
      return { launch_gate: value };
    case "git_tag":
      if (typeof value !== "string" || value.length === 0) {
        throw new RoadmapValidationError(
          `phases[${phaseIdx}].completion_criteria[${critIdx}].git_tag must be a non-empty string`,
        );
      }
      return { git_tag: value };
    case "lifecycle_transition":
      if (typeof value !== "string" || value.length === 0) {
        throw new RoadmapValidationError(
          `phases[${phaseIdx}].completion_criteria[${critIdx}].lifecycle_transition must be a non-empty string`,
        );
      }
      return { lifecycle_transition: value };
    default:
      throw new RoadmapValidationError(
        `phases[${phaseIdx}].completion_criteria[${critIdx}] uses unknown key "${key}". ` +
          `Supported: all_tasks_done, custom_check, launch_gate, git_tag, lifecycle_transition.`,
      );
  }
}

export function findPhase(roadmap: Roadmap, phaseId: string): RoadmapPhase | undefined {
  return roadmap.phases.find((p) => p.id === phaseId);
}

// Evaluate all completion criteria for a single phase. v1 supports
// `all_tasks_done` and `custom_check`; the other kinds return
// passed=false with detail="not supported in v1" so the operator
// sees they were declared but not evaluated. The dispatcher should
// treat the "not supported" criteria as blocking until a Phase B
// implementation lands.
export async function evaluateCriteria(
  phase: RoadmapPhase,
  projectConfig: ProjectConfig,
): Promise<PhaseCriterionResult[]> {
  const results: PhaseCriterionResult[] = [];
  for (const c of phase.completion_criteria) {
    if ("all_tasks_done" in c) {
      results.push(await evaluateAllTasksDone(projectConfig.id));
    } else if ("custom_check" in c) {
      results.push(await evaluateCustomCheck(c.custom_check, projectConfig.path));
    } else if ("launch_gate" in c) {
      results.push(
        await evaluateLaunchGate(c.launch_gate, projectConfig.path),
      );
    } else if ("git_tag" in c) {
      results.push(await evaluateGitTag(c.git_tag, projectConfig.path));
    } else if ("lifecycle_transition" in c) {
      results.push({
        kind: "lifecycle_transition",
        passed: false,
        detail: `lifecycle_transition "${c.lifecycle_transition}": evaluator not implemented in v1`,
      });
    }
  }
  return results;
}

async function evaluateAllTasksDone(projectId: string): Promise<PhaseCriterionResult> {
  try {
    const tasks = await loadTasks(projectId);
    const incomplete = tasks.filter(
      (t) => t.status !== "done" && t.status !== "skipped" && t.status !== "superseded",
    );
    if (incomplete.length === 0) {
      return {
        kind: "all_tasks_done",
        passed: true,
        detail: `${tasks.length} tasks: all done/skipped/superseded`,
      };
    }
    return {
      kind: "all_tasks_done",
      passed: false,
      detail: `${incomplete.length} of ${tasks.length} tasks not yet done: [${incomplete
        .slice(0, 5)
        .map((t) => t.id)
        .join(", ")}${incomplete.length > 5 ? ", ..." : ""}]`,
    };
  } catch (err) {
    return {
      kind: "all_tasks_done",
      passed: false,
      detail: `loadTasks failed: ${(err as Error).message}`,
    };
  }
}

// gs-303-followup / Phase B+ deferred item: LAUNCH-PLAN.md gate
// unification. ROADMAP.yaml's `launch_gate: "<gate-id>"` criterion
// resolves by looking for a checkbox bullet in the project's
// LAUNCH-PLAN.md whose first non-whitespace token after the checkbox
// matches the gate id (optionally **bold-wrapped**).
//
//   - [x] stripe-test-mode-verified — Stripe webhooks pass on staging
//   - [x] **lighthouse-mobile-85** — score 87 on /home, 89 on /browse
//   - [ ] first-paid-subscription — pending Phase 5
//
// Semantics:
//   - `[x]` (any-case) → gate closed (passed=true)
//   - `[ ]` → declared but open (passed=false, detail says "open")
//   - not present → not declared (passed=false, detail says "not found")
//   - LAUNCH-PLAN.md missing entirely → passed=false, detail explains
//
// Anchoring the gate id to the position immediately after the checkbox
// keeps a phrase like "stripe-test-mode-verified" inside another
// gate's description from producing a false positive.
async function evaluateLaunchGate(
  gateId: string,
  projectPath: string,
): Promise<PhaseCriterionResult> {
  const launchPlanPath = join(projectPath, "LAUNCH-PLAN.md");
  if (!existsSync(launchPlanPath)) {
    return {
      kind: "launch_gate",
      passed: false,
      detail: `launch_gate "${gateId}": LAUNCH-PLAN.md not found at ${launchPlanPath}`,
    };
  }
  let content: string;
  try {
    content = await readFile(launchPlanPath, "utf8");
  } catch (err) {
    return {
      kind: "launch_gate",
      passed: false,
      detail: `launch_gate "${gateId}": LAUNCH-PLAN.md unreadable: ${(err as Error).message}`,
    };
  }
  const escaped = gateId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idPattern = `(?:\\*\\*)?${escaped}(?:\\*\\*)?`;
  const checkedRe = new RegExp(
    `^\\s*-\\s+\\[(?:x|X)\\]\\s+${idPattern}(?:\\b|$)`,
    "m",
  );
  const uncheckedRe = new RegExp(
    `^\\s*-\\s+\\[\\s\\]\\s+${idPattern}(?:\\b|$)`,
    "m",
  );
  if (checkedRe.test(content)) {
    return {
      kind: "launch_gate",
      passed: true,
      detail: `launch_gate "${gateId}": closed`,
    };
  }
  if (uncheckedRe.test(content)) {
    return {
      kind: "launch_gate",
      passed: false,
      detail: `launch_gate "${gateId}": declared but open in LAUNCH-PLAN.md`,
    };
  }
  return {
    kind: "launch_gate",
    passed: false,
    detail: `launch_gate "${gateId}": not declared in LAUNCH-PLAN.md (expected a checkbox bullet starting with the gate id)`,
  };
}

// git_tag evaluator: passes when a tag with the exact name exists in
// the project's repo. Uses `git rev-parse --verify --quiet
// refs/tags/<tag>` rather than `git tag -l <name>` so wildcards
// (`v*`, `[v]0`) are NOT expanded — the criterion declares an
// exact tag id, not a glob. The `refs/tags/` prefix also disambiguates
// tags from branches when both share a name.
//
// GIT_CEILING_DIRECTORIES guards against the common surprise where
// projectPath isn't a git repo but a parent directory is (e.g. a
// fresh project nested inside a monorepo or inside the GS clone for
// testing). Without the ceiling, git walks up the tree and reports
// the parent's tags — producing a false positive. Mirrors the same
// defense in src/work_detection.ts's git_issues / git_unmerged paths.
async function evaluateGitTag(
  tagName: string,
  projectPath: string,
): Promise<PhaseCriterionResult> {
  try {
    const proc = Bun.spawn(
      ["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`],
      {
        cwd: projectPath,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: join(projectPath, ".."),
        },
      },
    );
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return {
        kind: "git_tag",
        passed: true,
        detail: `git_tag "${tagName}": tag exists in ${projectPath}`,
      };
    }
    // Non-zero exit covers both "tag missing" and "not a git repo" /
    // "git crash". Capture stderr so the operator can tell which.
    const stderrText = (await new Response(proc.stderr).text()).trim();
    if (stderrText.length === 0) {
      return {
        kind: "git_tag",
        passed: false,
        detail: `git_tag "${tagName}": tag does not exist in ${projectPath}`,
      };
    }
    return {
      kind: "git_tag",
      passed: false,
      detail: `git_tag "${tagName}": git rev-parse exited ${exitCode}; stderr: ${stderrText}`,
    };
  } catch (err) {
    return {
      kind: "git_tag",
      passed: false,
      detail: `git_tag "${tagName}": git invocation failed: ${(err as Error).message}`,
    };
  }
}

async function evaluateCustomCheck(
  cmd: string,
  projectPath: string,
): Promise<PhaseCriterionResult> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return {
        kind: "custom_check",
        passed: true,
        detail: `\`${cmd}\` exited 0`,
      };
    }
    const stderrStr = await new Response(proc.stderr).text();
    const stderrTrim = stderrStr.trim().split("\n").slice(-3).join("\n");
    return {
      kind: "custom_check",
      passed: false,
      detail: `\`${cmd}\` exited ${exitCode}${stderrTrim ? `; stderr tail: ${stderrTrim}` : ""}`,
    };
  } catch (err) {
    return {
      kind: "custom_check",
      passed: false,
      detail: `\`${cmd}\` failed to spawn: ${(err as Error).message}`,
    };
  }
}

export function allPassed(results: PhaseCriterionResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}

// Result of a successful phase advance. seeded_task_ids lists the
// task IDs that the next phase's `tasks:` literals were materialized
// into via tasks.json.
export interface PhaseAdvanceResult {
  from_phase: string;
  to_phase: string;
  seeded_task_ids: string[];
  forced: boolean;
}

// Record a phase advance: emits phase_complete, seeds next-phase
// literal tasks, flips PHASE_STATE.json, emits the trigger event
// (phase_advanced for the manual `gs phase advance` path,
// phase_auto_advanced for the opt-in auto-advance path). The caller
// is responsible for clearing the PHASE_READY.json sentinel if one
// was written (manual path does this in cli.ts; auto-advance path
// in phase_detector.ts).
//
// Pre-conditions assumed by the caller:
// - currentPhase + nextPhase are valid phases from the same Roadmap
// - criteriaResults reflect a fresh evaluation against currentPhase
// - if forced=true the caller has explicit operator intent; if false
//   then allPassed(criteriaResults) must already be true
export async function executePhaseAdvance(
  project: ProjectConfig,
  currentPhase: RoadmapPhase,
  nextPhase: RoadmapPhase,
  criteriaResults: PhaseCriterionResult[],
  options: {
    forced?: boolean;
    triggerEvent?: "phase_advanced" | "phase_auto_advanced";
  } = {},
): Promise<PhaseAdvanceResult> {
  const forced = options.forced ?? false;
  const triggerEvent = options.triggerEvent ?? "phase_advanced";

  await appendProgress(project.id, "phase_complete", {
    phase_id: currentPhase.id,
    criteria_results: criteriaResults,
    forced,
    timestamp: new Date().toISOString(),
  });

  // Materialize seeded tasks: literal `tasks:` first, then expanded
  // `tasks_template:` entries. Expansion uses {phase_id, prev_phase,
  // project_id, date, datetime} from buildExpansionContext.
  const seededTaskIds: string[] = [];
  const allTasks: RoadmapLiteralTask[] = [];
  if (nextPhase.tasks && nextPhase.tasks.length > 0) {
    allTasks.push(...nextPhase.tasks);
  }
  if (nextPhase.tasks_template && nextPhase.tasks_template.length > 0) {
    const ctx = buildExpansionContext(
      project.id,
      currentPhase.id,
      nextPhase.id,
    );
    allTasks.push(...expandTaskTemplates(nextPhase.tasks_template, ctx));
  }
  for (const t of allTasks) {
    const task = await addTask(project.id, t.title, t.priority ?? 2, {
      interactiveOnly: t.interactive_only,
      interactiveOnlyReason: t.interactive_only_reason,
      expectedTouches: t.expected_touches,
    });
    seededTaskIds.push(task.id);
  }

  await recordPhaseAdvance(
    project.id,
    currentPhase.id,
    nextPhase.id,
    criteriaResults,
  );

  await appendProgress(project.id, triggerEvent, {
    from_phase: currentPhase.id,
    to_phase: nextPhase.id,
    seeded_task_ids: seededTaskIds,
    timestamp: new Date().toISOString(),
  });

  return {
    from_phase: currentPhase.id,
    to_phase: nextPhase.id,
    seeded_task_ids: seededTaskIds,
    forced,
  };
}

// Default ROADMAP.yaml for `gs phase init`. Single phase, literal
// tasks, all_tasks_done criterion. Operator edits to taste.
export function defaultRoadmapYaml(projectId: string): string {
  return `# Phased roadmap for ${projectId}.
# Format reference: docs/conventions/roadmap.md
#
# v1 supports all_tasks_done + custom_check completion criteria.
# Templates are still deferred. Auto-advance ships in Phase B+
# (2026-05-04) — set \`auto_advance: true\` to have the
# session-start detector advance phases automatically when
# criteria pass. Default off (commander still runs
# \`gs phase advance\` manually).

project_id: ${projectId}
current_phase: mvp
# auto_advance: true   # Uncomment to opt into auto-advance.

phases:
  - id: mvp
    goal: "Working end-to-end flow, 0 users"
    completion_criteria:
      - all_tasks_done: true
    next_phase: launch

  - id: launch
    goal: "Public launch with at least one real user"
    depends_on: mvp
    tasks:
      - title: "Smoke-test the live deployment"
        priority: 1
      - title: "First-user announcement post"
        priority: 2
    completion_criteria:
      - all_tasks_done: true
`;
}
