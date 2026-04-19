// GeneralStaff — Phase 6 data-contract: per-project task queue view module (gs-222).
//
// Resolves a project's tasks.json into the four buckets used by the
// Phase 5 Task Queue HTML reference (in_flight / ready / blocked / shipped).
// Pure data — no rendering.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { loadProjects } from "../projects";
import { isTaskBotPickable } from "../tasks";
import type { GreenfieldTask, ProjectConfig } from "../types";

export interface TaskQueueEntry {
  id: string;
  title: string;
  priority: number;
  status: "pending" | "in_progress" | "done" | "skipped";
  expected_touches?: string[];
  interactive_only?: boolean;
  completed_at?: string;
  block_reason?: "interactive_only" | "hands_off_intersect";
  age_label?: string;
}

export interface TaskQueueData {
  project_id: string;
  in_flight: TaskQueueEntry[];
  ready: TaskQueueEntry[];
  blocked: TaskQueueEntry[];
  shipped: TaskQueueEntry[];
}

export class TaskQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskQueueError";
  }
}

const SHIPPED_CAP = 8;

type RawTask = GreenfieldTask & { completed_at?: string };

function parseTasks(raw: string): RawTask[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (t): t is RawTask =>
      t !== null &&
      typeof t === "object" &&
      typeof (t as RawTask).id === "string" &&
      typeof (t as RawTask).title === "string" &&
      typeof (t as RawTask).status === "string" &&
      typeof (t as RawTask).priority === "number",
  );
}

function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 60) {
    if (minutes <= 1) return "just now";
    return `${minutes}m ago`;
  }
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  return `${months[then.getMonth()]} ${then.getDate()}`;
}

function toEntry(task: RawTask): TaskQueueEntry {
  const entry: TaskQueueEntry = {
    id: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
  };
  if (task.expected_touches !== undefined) {
    entry.expected_touches = task.expected_touches;
  }
  if (task.interactive_only !== undefined) {
    entry.interactive_only = task.interactive_only;
  }
  if (task.completed_at !== undefined) {
    entry.completed_at = task.completed_at;
    const label = formatRelativeTime(task.completed_at);
    if (label) entry.age_label = label;
  }
  return entry;
}

async function readTasksFromProject(
  project: ProjectConfig,
): Promise<RawTask[] | null> {
  const path = join(project.path, "state", project.id, "tasks.json");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return [];
  try {
    return parseTasks(raw);
  } catch {
    return [];
  }
}

export async function getProjectTaskQueue(
  projectId: string,
): Promise<TaskQueueData> {
  const projects = await loadProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    throw new TaskQueueError(`unknown project: ${projectId}`);
  }

  const tasks = await readTasksFromProject(project);
  if (tasks === null) {
    return {
      project_id: projectId,
      in_flight: [],
      ready: [],
      blocked: [],
      shipped: [],
    };
  }

  const in_flight: TaskQueueEntry[] = [];
  const ready: TaskQueueEntry[] = [];
  const blocked: TaskQueueEntry[] = [];
  const shipped: TaskQueueEntry[] = [];

  for (const task of tasks) {
    if (task.status === "in_progress") {
      in_flight.push(toEntry(task));
      continue;
    }
    if (task.status === "pending") {
      const pickable = isTaskBotPickable(task, project.hands_off);
      if (pickable.ok) {
        ready.push(toEntry(task));
      } else if (
        pickable.reason === "interactive_only" ||
        pickable.reason === "hands_off_intersect"
      ) {
        const entry = toEntry(task);
        entry.block_reason = pickable.reason;
        blocked.push(entry);
      }
      continue;
    }
    if (task.status === "done" && task.completed_at) {
      shipped.push(toEntry(task));
    }
  }

  shipped.sort((a, b) => {
    const at = a.completed_at ?? "";
    const bt = b.completed_at ?? "";
    if (at < bt) return 1;
    if (at > bt) return -1;
    return 0;
  });

  return {
    project_id: projectId,
    in_flight,
    ready,
    blocked,
    shipped: shipped.slice(0, SHIPPED_CAP),
  };
}
