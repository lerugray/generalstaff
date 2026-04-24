// GeneralStaff — work detection module (build step 6)
// Q1 logic: detect whether a project has more work for chaining

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";
import { botPickableTasks, isTaskBotPickable } from "./tasks";
import type { ProjectConfig, GreenfieldTask } from "./types";

// gs-200: structured breakdown of remaining work. Distinguishes the
// three "pending" buckets that the dispatcher/queuer care about —
// bot-pickable work vs. interactive-only tasks vs. tasks whose
// expected_touches collide with hands_off — and reports in_progress /
// done / skipped alongside for `status --backlog` UIs. For non-
// tasks_json modes the fine-grained breakdown isn't observable from
// the source, so pending_bot_pickable carries the whole count and
// the refinement fields zero out.
export interface WorkBreakdown {
  pending_bot_pickable: number;
  pending_interactive_only: number;
  pending_handsoff_conflict: number;
  in_progress: number;
  done: number;
  skipped: number;
  total: number;
}

function emptyBreakdown(): WorkBreakdown {
  return {
    pending_bot_pickable: 0,
    pending_interactive_only: 0,
    pending_handsoff_conflict: 0,
    in_progress: 0,
    done: 0,
    skipped: 0,
    total: 0,
  };
}

export async function hasMoreWork(project: ProjectConfig): Promise<boolean> {
  switch (project.work_detection) {
    case "catalogdna_bot_tasks":
      return catalogdnaHasMoreWork(project.path);
    case "tasks_json":
      // gs-195: pass hands_off so tasks with conflicting
      // expected_touches (or interactive_only=true) are filtered out
      // before the dispatcher decides to chain.
      return greenfieldHasMoreWork(project.path, project.id, project.hands_off);
    case "git_issues":
      return gitIssuesHasMoreWork(project.path);
    case "git_unmerged":
      return gitUnmergedHasMoreWork(project.path, project.branch);
    default:
      return false; // unknown mode: fail-safe, no chaining
  }
}

export async function countRemainingWork(
  project: ProjectConfig,
): Promise<number> {
  switch (project.work_detection) {
    case "catalogdna_bot_tasks":
      return catalogdnaCountRemaining(project.path);
    case "tasks_json":
      return greenfieldCountRemaining(
        project.path,
        project.id,
        project.hands_off,
      );
    case "git_issues":
      return gitIssuesCountRemaining(project.path);
    case "git_unmerged":
      return gitUnmergedCountRemaining(project.path, project.branch);
    default:
      return 0;
  }
}

export async function countRemainingWorkDetailed(
  project: ProjectConfig,
): Promise<WorkBreakdown> {
  if (project.work_detection === "tasks_json") {
    return greenfieldCountRemainingDetailed(
      project.path,
      project.id,
      project.hands_off,
    );
  }
  // Non-tasks_json modes only expose a flat "pending" count at their
  // source (bot_tasks.md checkbox count, git commits ahead, etc.).
  // Surface that number in pending_bot_pickable and zero the rest.
  const count = await countRemainingWork(project);
  const b = emptyBreakdown();
  b.pending_bot_pickable = count;
  b.total = count;
  return b;
}

export async function greenfieldCountRemainingDetailed(
  projectPath: string,
  projectId: string,
  handsOff: string[] = [],
): Promise<WorkBreakdown> {
  const tasksPath = join(projectPath, "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) return emptyBreakdown();

  let tasks: GreenfieldTask[];
  try {
    const raw = await readFile(tasksPath, "utf8");
    tasks = JSON.parse(raw) as GreenfieldTask[];
    if (!Array.isArray(tasks)) return emptyBreakdown();
  } catch {
    return emptyBreakdown();
  }

  const b = emptyBreakdown();
  b.total = tasks.length;
  for (const task of tasks) {
    // gs-231: treat a stray `status: "completed"` the same as `done`
    // for breakdown bucketing. The validator rejects `"completed"`,
    // but this function bypasses loadTasks by casting JSON.parse
    // output directly, so a historical `"completed"` value could
    // otherwise fall through to the default pending bucket below.
    const statusLabel = task.status as string;
    if (task.status === "done" || statusLabel === "completed") {
      b.done += 1;
      continue;
    }
    if (task.status === "skipped" || task.status === "superseded") {
      // gs-301-split convention (CLAUDE.local.md §"Diagnose bot-task
      // failures"): "superseded" marks a task whose intent moved to
      // split children via `supersedes_note`. Bucketed with skipped
      // for the dispatcher's "nothing bot-pickable to do here" check.
      b.skipped += 1;
      continue;
    }
    if (task.status === "in_progress") {
      b.in_progress += 1;
      continue;
    }
    // status === "pending" (or any unknown status treated as pending);
    // classify via isTaskBotPickable so the bucket split matches the
    // dispatcher's actual pick logic.
    const p = isTaskBotPickable(task, handsOff);
    if (p.ok) {
      b.pending_bot_pickable += 1;
    } else if (p.reason === "interactive_only") {
      b.pending_interactive_only += 1;
    } else if (p.reason === "hands_off_intersect") {
      b.pending_handsoff_conflict += 1;
    } else {
      // reason === "not_pending" — covered by the status branches
      // above. Defensive no-op in case isTaskBotPickable grows a new
      // reason later.
    }
  }
  return b;
}

export async function catalogdnaCountRemaining(
  catalogdnaPath: string,
): Promise<number> {
  const botTasksPath = join(catalogdnaPath, "bot_tasks.md");
  if (!existsSync(botTasksPath)) return 0;

  let content: string;
  try {
    content = await readFile(botTasksPath, "utf8");
  } catch {
    return 0;
  }

  const sections = content.split(/^## /m);
  let totalUnchecked = 0;
  for (const section of sections) {
    const firstLine = section.split("\n")[0] ?? "";
    if (!/^P[0-3]\b/.test(firstLine)) continue;
    if (/COMPLETED|SKIP/i.test(firstLine)) continue;
    const unchecked = (section.match(/^- \[ \]/gm) ?? []).length;
    totalUnchecked += unchecked;
  }
  return totalUnchecked;
}

export async function greenfieldCountRemaining(
  projectPath: string,
  projectId: string,
  handsOff: string[] = [],
): Promise<number> {
  const tasksPath = join(projectPath, "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) return 0;

  try {
    const raw = await readFile(tasksPath, "utf8");
    const tasks = JSON.parse(raw) as GreenfieldTask[];
    // gs-195: count only tasks the bot can actually pick up. Tasks
    // marked interactive_only or whose expected_touches would collide
    // with hands_off don't contribute to "work the bot has left to
    // do" and so shouldn't gate chaining or session pickers.
    return botPickableTasks(tasks, handsOff).length;
  } catch {
    return 0;
  }
}

export async function catalogdnaHasMoreWork(
  catalogdnaPath: string,
): Promise<boolean> {
  const botTasksPath = join(catalogdnaPath, "bot_tasks.md");
  if (!existsSync(botTasksPath)) return false;

  let content: string;
  try {
    content = await readFile(botTasksPath, "utf8");
  } catch {
    return false; // can't read: fail-safe
  }

  // Split into sections by top-level ## headers
  const sections = content.split(/^## /m);

  let totalUnchecked = 0;
  for (const section of sections) {
    const firstLine = section.split("\n")[0] ?? "";
    // Only count P0-P3 sections
    if (!/^P[0-3]\b/.test(firstLine)) continue;
    // Skip completed/skipped sections
    if (/COMPLETED|SKIP/i.test(firstLine)) continue;
    // Count unchecked boxes
    const unchecked = (section.match(/^- \[ \]/gm) ?? []).length;
    totalUnchecked += unchecked;
  }

  return totalUnchecked > 0;
}

export async function greenfieldHasMoreWork(
  projectPath: string,
  projectId: string,
  handsOff: string[] = [],
): Promise<boolean> {
  const tasksPath = join(projectPath, "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) return false;

  try {
    const raw = await readFile(tasksPath, "utf8");
    const tasks = JSON.parse(raw) as GreenfieldTask[];
    // gs-195: "more work" is bot-pickable work — skip interactive-
    // only tasks and tasks whose expected_touches collide with
    // hands_off.
    return botPickableTasks(tasks, handsOff).length > 0;
  } catch {
    return false; // malformed: fail-safe
  }
}

// git_issues mode: counts commits ahead of origin/master as a proxy for
// pending work. Useful for projects where bot work lands on a branch and
// is considered "pending" until merged into the upstream master.
export async function gitIssuesCountRemaining(
  projectPath: string,
): Promise<number> {
  // Use GIT_CEILING_DIRECTORIES to prevent walking up to parent repos
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: join(projectPath, "..") };
  const result = spawnSync(
    "git",
    ["log", "--oneline", "origin/master..HEAD"],
    {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return 0;
  const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
  return lines.length;
}

export async function gitIssuesHasMoreWork(
  projectPath: string,
): Promise<boolean> {
  return (await gitIssuesCountRemaining(projectPath)) > 0;
}

// git_unmerged mode: counts commits on the project's bot branch ahead of
// local master as a proxy for pending work. Useful for projects without
// an explicit tasks.json — work is "pending" until merged into master.
export async function gitUnmergedCountRemaining(
  projectPath: string,
  branch: string,
): Promise<number> {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: join(projectPath, "..") };
  const result = spawnSync(
    "git",
    ["rev-list", "--count", `master..${branch}`],
    {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return 0;
  const n = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function gitUnmergedHasMoreWork(
  projectPath: string,
  branch: string,
): Promise<boolean> {
  return (await gitUnmergedCountRemaining(projectPath, branch)) > 0;
}
