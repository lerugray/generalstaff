// GeneralStaff — work detection module (build step 6)
// Q1 logic: detect whether a project has more work for chaining

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";
import { getRootDir } from "./state";
import type { ProjectConfig } from "./types";

export async function hasMoreWork(project: ProjectConfig): Promise<boolean> {
  switch (project.work_detection) {
    case "catalogdna_bot_tasks":
      return catalogdnaHasMoreWork(project.path);
    case "tasks_json":
      return greenfieldHasMoreWork(project.id);
    case "git_issues":
      return gitIssuesHasMoreWork(project.path);
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
      return greenfieldCountRemaining(project.id);
    case "git_issues":
      return gitIssuesCountRemaining(project.path);
    default:
      return 0;
  }
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
  projectId: string,
): Promise<number> {
  const tasksPath = join(getRootDir(), "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) return 0;

  try {
    const raw = await readFile(tasksPath, "utf8");
    const tasks = JSON.parse(raw) as Array<{ status: string }>;
    return tasks.filter(
      (t) => t.status !== "done" && t.status !== "skipped",
    ).length;
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
  projectId: string,
): Promise<boolean> {
  const tasksPath = join(getRootDir(), "state", projectId, "tasks.json");
  if (!existsSync(tasksPath)) return false;

  try {
    const raw = await readFile(tasksPath, "utf8");
    const tasks = JSON.parse(raw) as Array<{ status: string }>;
    return tasks.some(
      (t) => t.status !== "done" && t.status !== "skipped",
    );
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
  const result = spawnSync(
    "git",
    ["log", "--oneline", "origin/master..HEAD"],
    {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
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
