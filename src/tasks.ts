// GeneralStaff — tasks.json read/write helpers for the `task` CLI command.

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { getRootDir } from "./state";
import { matchesHandsOff } from "./safety";
import type { GreenfieldTask, EngineerProvider } from "./types";
import { VALID_ENGINEER_PROVIDERS } from "./types";

function tasksPath(projectId: string): string {
  return join(getRootDir(), "state", projectId, "tasks.json");
}

export class TasksLoadError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(`Failed to load tasks from ${filePath}: ${reason}`);
    this.name = "TasksLoadError";
  }
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

const VALID_TASK_STATUSES: readonly GreenfieldTask["status"][] = [
  "pending",
  "in_progress",
  "done",
  "skipped",
];

// gs-218: structural validation for each tasks.json entry. Unknown
// fields pass through silently so engineer-added bookkeeping
// (e.g. `completed_at`, gs-195's `expected_touches` /
// `interactive_only`) stays forward-compatible. The `fileLabel`
// argument is the filename portion used in error messages ("tasks.json")
// so callers can customize it if tasks ever land in a non-standard path.
function validateTaskEntry(
  entry: unknown,
  index: number,
  fileLabel: string,
): GreenfieldTask {
  const loc = `${fileLabel}[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TaskValidationError(
      `${loc}: expected an object, got ${entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry}`,
    );
  }
  const rec = entry as Record<string, unknown>;

  if (!("id" in rec)) {
    throw new TaskValidationError(`${loc}: missing required field 'id'`);
  }
  if (typeof rec.id !== "string" || rec.id.length === 0) {
    throw new TaskValidationError(
      `${loc}: 'id' must be a non-empty string, got ${JSON.stringify(rec.id)}`,
    );
  }

  if (!("title" in rec)) {
    throw new TaskValidationError(`${loc}: missing required field 'title'`);
  }
  if (typeof rec.title !== "string") {
    throw new TaskValidationError(
      `${loc}: 'title' must be a string, got ${typeof rec.title}`,
    );
  }

  if (!("status" in rec)) {
    throw new TaskValidationError(`${loc}: missing required field 'status'`);
  }
  if (
    typeof rec.status !== "string" ||
    !VALID_TASK_STATUSES.includes(rec.status as GreenfieldTask["status"])
  ) {
    throw new TaskValidationError(
      `${loc}: 'status' must be one of ${VALID_TASK_STATUSES.join(", ")}, got ${JSON.stringify(rec.status)}`,
    );
  }

  if (!("priority" in rec)) {
    throw new TaskValidationError(`${loc}: missing required field 'priority'`);
  }
  if (
    typeof rec.priority !== "number" ||
    !Number.isFinite(rec.priority) ||
    !Number.isInteger(rec.priority) ||
    rec.priority <= 0
  ) {
    throw new TaskValidationError(
      `${loc}: 'priority' must be a positive integer, got ${JSON.stringify(rec.priority)}`,
    );
  }

  // gs-275: per-task engineer override. Catch typos at load time.
  if ("engineer_provider" in rec && rec.engineer_provider !== undefined && rec.engineer_provider !== null) {
    if (typeof rec.engineer_provider !== "string") {
      throw new TaskValidationError(
        `${loc}: 'engineer_provider' must be a string if set, got ${typeof rec.engineer_provider}`,
      );
    }
    if (!VALID_ENGINEER_PROVIDERS.includes(rec.engineer_provider as EngineerProvider)) {
      throw new TaskValidationError(
        `${loc}: 'engineer_provider' must be one of ${VALID_ENGINEER_PROVIDERS.join(", ")}, got ${JSON.stringify(rec.engineer_provider)}`,
      );
    }
  }
  if ("engineer_model" in rec && rec.engineer_model !== undefined && rec.engineer_model !== null) {
    if (typeof rec.engineer_model !== "string" || rec.engineer_model.length === 0) {
      throw new TaskValidationError(
        `${loc}: 'engineer_model' must be a non-empty string if set, got ${JSON.stringify(rec.engineer_model)}`,
      );
    }
  }

  // gs-278: creative-work opt-in (Hard Rule #1 carve-out). Tasks that
  // set creative=true are routed differently by the dispatcher — see
  // docs/internal/RULE-RELAXATION-2026-04-20.md for the policy.
  if ("creative" in rec && rec.creative !== undefined && rec.creative !== null) {
    if (typeof rec.creative !== "boolean") {
      throw new TaskValidationError(
        `${loc}: 'creative' must be a boolean if set, got ${typeof rec.creative}`,
      );
    }
  }
  if (
    "voice_reference_override" in rec &&
    rec.voice_reference_override !== undefined &&
    rec.voice_reference_override !== null
  ) {
    if (!Array.isArray(rec.voice_reference_override)) {
      throw new TaskValidationError(
        `${loc}: 'voice_reference_override' must be an array, got ${typeof rec.voice_reference_override}`,
      );
    }
    for (let j = 0; j < rec.voice_reference_override.length; j++) {
      const entry = rec.voice_reference_override[j];
      if (typeof entry !== "string" || entry.length === 0) {
        throw new TaskValidationError(
          `${loc}: 'voice_reference_override[${j}]' must be a non-empty string`,
        );
      }
    }
  }

  return rec as unknown as GreenfieldTask;
}

export async function loadTasks(
  projectId: string,
  warn: (msg: string) => void = console.warn,
): Promise<GreenfieldTask[]> {
  const path = tasksPath(projectId);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TasksLoadError(path, `invalid JSON (${detail})`, err);
  }
  if (!Array.isArray(parsed)) {
    throw new TasksLoadError(
      path,
      `expected a JSON array, got ${parsed === null ? "null" : typeof parsed}`,
    );
  }
  const validated: GreenfieldTask[] = [];
  for (let i = 0; i < parsed.length; i++) {
    validated.push(validateTaskEntry(parsed[i], i, "tasks.json"));
  }
  // `warn` is plumbed in for future soft-diagnostic use (e.g. deprecated
  // field shapes) without forcing callers to change their call sites.
  // Present tense: unused here, but keeps the signature stable.
  void warn;
  return validated;
}

export function pendingTasks(tasks: GreenfieldTask[]): GreenfieldTask[] {
  return tasks.filter((t) => t.status !== "done" && t.status !== "skipped");
}

// gs-195: decide whether a bot cycle can pick this task. A task is
// bot-pickable when it is (1) pending, (2) not flagged
// interactive_only, and (3) its expected_touches (if any) don't
// intersect the project's hands_off patterns. Tasks without either
// new field remain pickable by default so legacy tasks.json files
// keep working.
//
// The returned reason on skip is structured so the caller can log
// the specific conflict for queuer feedback (which expected_touch
// matched which hands_off pattern).
export type TaskPickabilityReason =
  | { ok: true }
  | { ok: false; reason: "not_pending" }
  | { ok: false; reason: "interactive_only" }
  | {
      ok: false;
      reason: "hands_off_intersect";
      conflict: { pattern: string; touch: string };
    }
  // gs-278: the picked task carries `creative: true` but the project
  // has not opted in via `creative_work_allowed: true`. Surfaces
  // distinctly so the dispatcher can log it instead of silently
  // eliding a queued creative task.
  | { ok: false; reason: "creative_work_not_allowed_for_project" };

// gs-278: optional context the bot-pickability check uses for
// project-scoped policies that aren't captured by hands_off alone.
// Kept as an object so future policies (e.g. scheduling windows) can
// be added without breaking existing callers — all fields are
// optional and have safe defaults (treat the project as not opting
// in).
export interface BotPickabilityProjectContext {
  creativeWorkAllowed?: boolean;
}

/**
 * Decide whether a bot cycle can pick up this task.
 *
 * A task is bot-pickable when (1) its status is not `done` or `skipped`,
 * (2) it isn't flagged `interactive_only`, and (3) its `expected_touches`
 * (if any) don't intersect the project's `handsOff` patterns. Legacy tasks
 * without the gs-195 fields (`expected_touches`, `interactive_only`)
 * remain pickable by default so existing `tasks.json` files keep working.
 *
 * The returned tagged-union reason on a `false` result lets callers log
 * the specific conflict — which `expected_touches` entry matched which
 * hands_off pattern — for queuer feedback.
 *
 * @param task The task under consideration.
 * @param handsOff The project's `hands_off` patterns (glob strings).
 * @returns `{ok: true}` if pickable; otherwise a tagged reason object.
 */
export function isTaskBotPickable(
  task: GreenfieldTask,
  handsOff: string[],
  projectCtx?: BotPickabilityProjectContext,
): TaskPickabilityReason {
  // Mirror pendingTasks() semantic: bot-pickable starts from the same
  // "not-done-and-not-skipped" filter (so in_progress tasks remain
  // pickable by the bot's next cycle). The new gates layer on top.
  // gs-231: also treat a stray `status: "completed"` as terminal.
  // The validator (validateTaskEntry) rejects that value, but raw
  // reads that bypass loadTasks (e.g. greenfieldCountRemainingDetailed
  // casts JSON.parse output directly) could still surface it. Guard
  // defensively here so unknown-but-terminal statuses don't leak back
  // into the bot-pickable pool.
  const terminalStatus = task.status as string;
  if (
    terminalStatus === "done" ||
    terminalStatus === "skipped" ||
    terminalStatus === "completed"
  ) {
    return { ok: false, reason: "not_pending" };
  }
  if (task.interactive_only) {
    return { ok: false, reason: "interactive_only" };
  }
  if (task.expected_touches && task.expected_touches.length > 0) {
    for (const touch of task.expected_touches) {
      const pattern = matchesHandsOff(touch, handsOff);
      if (pattern) {
        return {
          ok: false,
          reason: "hands_off_intersect",
          conflict: { pattern, touch },
        };
      }
    }
  }
  // gs-278: creative-work carve-out (Hard Rule #1 opt-in). Defaults
  // are conservative — if projectCtx is omitted or doesn't opt in, any
  // creative-tagged task is skipped. Existing call sites that haven't
  // been updated to pass projectCtx therefore preserve Rule #1's
  // default-off behaviour unchanged.
  if (task.creative === true && projectCtx?.creativeWorkAllowed !== true) {
    return { ok: false, reason: "creative_work_not_allowed_for_project" };
  }
  return { ok: true };
}

export function botPickableTasks(
  tasks: GreenfieldTask[],
  handsOff: string[],
  projectCtx?: BotPickabilityProjectContext,
): GreenfieldTask[] {
  return tasks.filter((t) => isTaskBotPickable(t, handsOff, projectCtx).ok);
}

// Reason a pending task is surfaced to the operator instead of the bot:
// - `interactive_only` — task was explicitly flagged interactive_only
// - `hands_off`        — expected_touches intersects the project's hands_off
// - `creative`         — creative: true on a project without creative_work_allowed
export type InteractiveReason = "interactive_only" | "hands_off" | "creative";

export interface InteractiveTaskRow {
  task: GreenfieldTask;
  reason: InteractiveReason;
}

/**
 * List pending tasks the bot *won't* pick — i.e. work that needs the operator.
 *
 * Complements `botPickableTasks`: together they partition `pendingTasks(...)`
 * into the two Hammerstein quadrants (bot-correctness vs operator-taste).
 * Done/skipped tasks are filtered out regardless.
 */
export function interactiveTasks(
  tasks: GreenfieldTask[],
  handsOff: string[],
  projectCtx?: BotPickabilityProjectContext,
): InteractiveTaskRow[] {
  const rows: InteractiveTaskRow[] = [];
  for (const task of tasks) {
    const p = isTaskBotPickable(task, handsOff, projectCtx);
    if (p.ok) continue;
    if (p.reason === "not_pending") continue;
    if (p.reason === "interactive_only") {
      rows.push({ task, reason: "interactive_only" });
    } else if (p.reason === "hands_off_intersect") {
      rows.push({ task, reason: "hands_off" });
    } else if (p.reason === "creative_work_not_allowed_for_project") {
      rows.push({ task, reason: "creative" });
    }
  }
  return rows;
}

// Parse the numeric suffix from a task id like "gamr-027" → 27 or
// "gs-270" → 270 for deterministic ordering among same-priority tasks.
// Falls back to Infinity when the id doesn't carry a numeric suffix so
// alphanumeric-only ids sort last rather than crashing.
function taskIdSortKey(id: string): number {
  const match = id.match(/-(\d+)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  return parseInt(match[1], 10);
}

// gs-275: return the task the bot engineer would pick next under the
// current rules. Mirrors the engineer prompt's decision logic exactly:
// (1) filter to bot-pickable (pending, not interactive_only, no
// hands_off intersection), (2) sort by priority ascending (1 = highest),
// (3) break ties by numeric-suffix on id ascending. Returns undefined
// if no task is pickable.
//
// The dispatcher calls this upstream of `runEngineer` so it can
// resolve task-level engineer overrides (task.engineer_provider,
// task.engineer_model) before spawning the engineer subprocess.
// Because the engineer's own pick rules are identical, the two will
// converge on the same task — we're peeking, not constraining.
export function nextBotPickableTask(
  tasks: GreenfieldTask[],
  handsOff: string[],
  projectCtx?: BotPickabilityProjectContext,
): GreenfieldTask | undefined {
  const pickable = botPickableTasks(tasks, handsOff, projectCtx);
  if (pickable.length === 0) return undefined;
  const sorted = [...pickable].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aKey = taskIdSortKey(a.id);
    const bKey = taskIdSortKey(b.id);
    if (aKey !== bKey) return aKey - bKey;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

export interface TaskCounts {
  pending: number;
  done: number;
  total: number;
}

export function countTasks(tasks: GreenfieldTask[]): TaskCounts {
  return {
    pending: pendingTasks(tasks).length,
    done: tasks.filter((t) => t.status === "done").length,
    total: tasks.length,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function deriveTaskIdPrefix(
  projectId: string,
  existing: GreenfieldTask[],
): string {
  for (const t of existing) {
    const m = /^([a-zA-Z]+-)\d+$/.exec(t.id);
    if (m) return m[1]!;
  }
  const initials = projectId
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 2)
    .toLowerCase();
  return (initials || "task") + "-";
}

export function nextTaskId(
  existing: GreenfieldTask[],
  prefix: string,
): string {
  const re = new RegExp("^" + escapeRegex(prefix) + "(\\d+)$");
  let maxN = 0;
  let width = 3;
  for (const t of existing) {
    const m = re.exec(t.id);
    if (m) {
      const digits = m[1]!;
      const n = parseInt(digits, 10);
      if (n > maxN) maxN = n;
      if (digits.length > width) width = digits.length;
    }
  }
  return prefix + String(maxN + 1).padStart(width, "0");
}

// gs-253: optional queue-time bot-pickability hints. All fields are
// opt-in; omitting them reproduces the pre-gs-253 behaviour.
export interface AddTaskOptions {
  interactiveOnly?: boolean;
  interactiveOnlyReason?: string;
  expectedTouches?: string[];
}

export async function addTask(
  projectId: string,
  title: string,
  priority = 2,
  options: AddTaskOptions = {},
): Promise<GreenfieldTask> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new TaskValidationError("task title cannot be empty");
  }
  const path = tasksPath(projectId);
  const existing = await loadTasks(projectId);
  const prefix = deriveTaskIdPrefix(projectId, existing);
  const task: GreenfieldTask = {
    id: nextTaskId(existing, prefix),
    title: trimmed,
    status: "pending",
    priority,
  };
  if (options.expectedTouches && options.expectedTouches.length > 0) {
    task.expected_touches = options.expectedTouches;
  }
  if (options.interactiveOnly === true) {
    task.interactive_only = true;
    if (options.interactiveOnlyReason !== undefined) {
      task.interactive_only_reason = options.interactiveOnlyReason;
    }
  }
  const updated = [...existing, task];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return task;
}

export type MarkTaskDoneResult =
  | { kind: "done"; task: GreenfieldTask }
  | { kind: "already_done"; task: GreenfieldTask }
  | { kind: "task_not_found"; availableIds: string[] }
  | { kind: "project_not_found"; path: string };

export async function markTaskDone(
  projectId: string,
  taskId: string,
): Promise<MarkTaskDoneResult> {
  const path = tasksPath(projectId);
  if (!existsSync(path)) {
    return { kind: "project_not_found", path };
  }
  const tasks = await loadTasks(projectId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return { kind: "task_not_found", availableIds: tasks.map((t) => t.id) };
  }
  const task = tasks[idx]!;
  if (task.status === "done") {
    return { kind: "already_done", task };
  }
  const updated = [...tasks];
  updated[idx] = { ...task, status: "done" };
  await writeFile(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { kind: "done", task: updated[idx]! };
}

export type RemoveTaskResult =
  | { kind: "removed"; task: GreenfieldTask }
  | { kind: "task_not_found"; availableIds: string[] }
  | { kind: "project_not_found"; path: string };

export async function removeTask(
  projectId: string,
  taskId: string,
): Promise<RemoveTaskResult> {
  const path = tasksPath(projectId);
  if (!existsSync(path)) {
    return { kind: "project_not_found", path };
  }
  const tasks = await loadTasks(projectId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return { kind: "task_not_found", availableIds: tasks.map((t) => t.id) };
  }
  const task = tasks[idx]!;
  const updated = tasks.filter((_, i) => i !== idx);
  await writeFile(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { kind: "removed", task };
}

export type MarkTaskInteractiveResult =
  | { kind: "set"; task: GreenfieldTask; previous: boolean }
  | { kind: "unchanged"; task: GreenfieldTask; value: boolean }
  | { kind: "task_not_found"; availableIds: string[] }
  | { kind: "project_not_found"; path: string };

// gs-243: toggle a task's `interactive_only` flag from the CLI, so
// operators don't have to hand-edit tasks.json. `value=true` marks the
// task interactive-only (the bot picker will skip it); `value=false`
// clears the flag. When the flag is already in the requested state we
// short-circuit without rewriting the file — mirrors the
// already_done / already_pending pattern used elsewhere in this module.
export async function markTaskInteractive(
  projectId: string,
  taskId: string,
  value: boolean,
): Promise<MarkTaskInteractiveResult> {
  const path = tasksPath(projectId);
  if (!existsSync(path)) {
    return { kind: "project_not_found", path };
  }
  const tasks = await loadTasks(projectId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return { kind: "task_not_found", availableIds: tasks.map((t) => t.id) };
  }
  const task = tasks[idx]!;
  const current = task.interactive_only === true;
  if (current === value) {
    return { kind: "unchanged", task, value };
  }
  const updated = [...tasks];
  if (value) {
    updated[idx] = { ...task, interactive_only: true };
  } else {
    // Strip the field entirely when clearing so tasks.json stays clean
    // for tasks that never needed the flag in the first place.
    const { interactive_only: _omit, ...rest } = task;
    void _omit;
    updated[idx] = rest as GreenfieldTask;
  }
  await writeFile(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { kind: "set", task: updated[idx]!, previous: current };
}

export type MarkTaskPendingResult =
  | { kind: "reopened"; task: GreenfieldTask }
  | { kind: "already_pending"; task: GreenfieldTask }
  | { kind: "task_not_found"; availableIds: string[] }
  | { kind: "project_not_found"; path: string };

export async function markTaskPending(
  projectId: string,
  taskId: string,
): Promise<MarkTaskPendingResult> {
  const path = tasksPath(projectId);
  if (!existsSync(path)) {
    return { kind: "project_not_found", path };
  }
  const tasks = await loadTasks(projectId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return { kind: "task_not_found", availableIds: tasks.map((t) => t.id) };
  }
  const task = tasks[idx]!;
  if (task.status === "pending") {
    return { kind: "already_pending", task };
  }
  const updated = [...tasks];
  updated[idx] = { ...task, status: "pending" };
  await writeFile(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { kind: "reopened", task: updated[idx]! };
}
