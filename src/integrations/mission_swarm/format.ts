// gs-307: formatting helpers for the mission-swarm preview cache.
// `generalstaff todo` uses these to surface a "[simulated]" marker
// and (optionally) the summary's first paragraph inline — without
// spawning missionswarm or re-running the hook.

import { existsSync } from "fs";
import { readFileSync } from "fs";
import { join } from "path";
import type { GreenfieldTask, ProjectConfig } from "../../types";
import { defaultCacheDir, hashInvocation } from "./hook";
import {
  DEFAULT_N_AGENTS,
  DEFAULT_N_ROUNDS,
  type MissionSwarmInvocation,
} from "./types";

export interface CachedPreviewLookup {
  exists: boolean;
  summaryPath: string | null;
  summary: string | null;
  firstParagraph: string | null;
}

export function invocationForTask(
  task: GreenfieldTask,
  project: ProjectConfig,
): MissionSwarmInvocation | null {
  if (!project.missionswarm) return null;
  return {
    taskId: task.id,
    taskDescription: task.title,
    projectId: project.id,
    audience: project.missionswarm.default_audience,
    nAgents: project.missionswarm.n_agents ?? DEFAULT_N_AGENTS,
    nRounds: project.missionswarm.n_rounds ?? DEFAULT_N_ROUNDS,
  };
}

export function lookupCachedPreview(
  task: GreenfieldTask,
  project: ProjectConfig,
  opts: { cacheDir?: string } = {},
): CachedPreviewLookup {
  const invocation = invocationForTask(task, project);
  if (!invocation) {
    return { exists: false, summaryPath: null, summary: null, firstParagraph: null };
  }
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const summaryPath = join(cacheDir, `${hashInvocation(invocation)}.md`);
  if (!existsSync(summaryPath)) {
    return { exists: false, summaryPath, summary: null, firstParagraph: null };
  }
  let summary: string | null = null;
  try {
    summary = readFileSync(summaryPath, "utf8");
  } catch {
    return { exists: false, summaryPath, summary: null, firstParagraph: null };
  }
  return {
    exists: true,
    summaryPath,
    summary,
    firstParagraph: firstParagraphOf(summary),
  };
}

export function firstParagraphOf(body: string): string {
  // Skip leading blank lines + markdown heading ("## ..."); return the
  // first non-empty paragraph after that.
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("#"))) {
    i++;
  }
  const buf: string[] = [];
  while (i < lines.length && lines[i].trim() !== "") {
    buf.push(lines[i]);
    i++;
  }
  return buf.join(" ").trim();
}
