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
  type PhaseCriterionResult,
} from "./types";
import { getRootDir } from "./state";
import { loadTasks } from "./tasks";
import type { ProjectConfig } from "./types";

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
  return {
    project_id: o.project_id,
    current_phase: o.current_phase,
    phases,
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

  // tasks_template explicitly rejected in v1 per
  // FUTURE-DIRECTIONS-2026-04-19 §8.
  if (p.tasks_template != null) {
    throw new RoadmapValidationError(
      `phases[${idx}] uses tasks_template which is not supported in v1. ` +
        `Use literal tasks: instead, or wait for the templates feature.`,
    );
  }

  let tasks: RoadmapPhase["tasks"];
  if (p.tasks != null) {
    if (!Array.isArray(p.tasks)) {
      throw new RoadmapValidationError(`phases[${idx}].tasks must be a list`);
    }
    tasks = p.tasks.map((t, j) => {
      if (t == null || typeof t !== "object") {
        throw new RoadmapValidationError(
          `phases[${idx}].tasks[${j}] is not a mapping`,
        );
      }
      const task = t as Record<string, unknown>;
      if (typeof task.title !== "string" || task.title.length === 0) {
        throw new RoadmapValidationError(
          `phases[${idx}].tasks[${j}].title is required and must be a string`,
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

  return {
    id: p.id,
    goal: p.goal,
    depends_on: typeof p.depends_on === "string" ? p.depends_on : undefined,
    tasks,
    completion_criteria: criteria,
    next_phase: typeof p.next_phase === "string" ? p.next_phase : undefined,
  };
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
      results.push({
        kind: "launch_gate",
        passed: false,
        detail: `launch_gate "${c.launch_gate}": evaluator not implemented in v1`,
      });
    } else if ("git_tag" in c) {
      results.push({
        kind: "git_tag",
        passed: false,
        detail: `git_tag "${c.git_tag}": evaluator not implemented in v1`,
      });
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

// Default ROADMAP.yaml for `gs phase init`. Single phase, literal
// tasks, all_tasks_done criterion. Operator edits to taste.
export function defaultRoadmapYaml(projectId: string): string {
  return `# Phased roadmap for ${projectId}.
# Format reference: docs/conventions/roadmap.md
#
# v1 supports all_tasks_done + custom_check completion criteria.
# Templates and auto-advance are deferred (FUTURE-DIRECTIONS-
# 2026-04-19 §8). Edit this file to describe the campaign.

project_id: ${projectId}
current_phase: mvp

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
