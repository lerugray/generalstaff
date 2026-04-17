// GeneralStaff — tasks.json read/write helpers for the `task` CLI command.

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { getRootDir } from "./state";
import type { GreenfieldTask } from "./types";

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

export async function loadTasks(projectId: string): Promise<GreenfieldTask[]> {
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
  return parsed as GreenfieldTask[];
}

export function pendingTasks(tasks: GreenfieldTask[]): GreenfieldTask[] {
  return tasks.filter((t) => t.status !== "done" && t.status !== "skipped");
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

export async function addTask(
  projectId: string,
  title: string,
  priority = 2,
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
