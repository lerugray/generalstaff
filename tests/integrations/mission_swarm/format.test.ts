// gs-307: tests for the cached-preview lookup + paragraph helper.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  firstParagraphOf,
  lookupCachedPreview,
} from "../../../src/integrations/mission_swarm/format";
import { hashInvocation } from "../../../src/integrations/mission_swarm/hook";
import type {
  GreenfieldTask,
  ProjectConfig,
} from "../../../src/types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `gs-ms-format-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

const TASK: GreenfieldTask = {
  id: "wdb-001",
  title: "Launch WDB hardcopy at $20",
  status: "pending",
  priority: 1,
};

function makeProject(missionswarm: ProjectConfig["missionswarm"]): ProjectConfig {
  return {
    id: "wargame-design-book",
    path: "/tmp/wdb",
    priority: 1,
    engineer_command: "claude",
    verification_command: "true",
    cycle_budget_minutes: 10,
    work_detection: "tasks_json",
    concurrency_detection: "worktree",
    branch: "master",
    auto_merge: false,
    hands_off: [],
    missionswarm,
  };
}

describe("firstParagraphOf", () => {
  it("returns the first paragraph after a heading", () => {
    const body = "## Input\n\nA wargame design book. Pricing is tight.\n\n## Reaction arc\n\nNext section.";
    expect(firstParagraphOf(body)).toBe("A wargame design book. Pricing is tight.");
  });

  it("joins multi-line paragraphs with single spaces", () => {
    const body = "## Heading\n\nFirst line.\nSecond line.\nThird line.\n\nAnother section.";
    expect(firstParagraphOf(body)).toBe("First line. Second line. Third line.");
  });

  it("returns empty string on all-blank or heading-only input", () => {
    expect(firstParagraphOf("## Only heading\n")).toBe("");
    expect(firstParagraphOf("\n\n\n")).toBe("");
  });
});

describe("lookupCachedPreview", () => {
  it("returns exists=false when project has no missionswarm config", () => {
    const project = makeProject(undefined);
    const result = lookupCachedPreview(TASK, project, { cacheDir: tmpDir });
    expect(result.exists).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.summaryPath).toBeNull();
  });

  it("returns exists=false when cache file missing", () => {
    const project = makeProject({ default_audience: "gaming-community" });
    const result = lookupCachedPreview(TASK, project, { cacheDir: tmpDir });
    expect(result.exists).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.summaryPath).not.toBeNull();
  });

  it("returns exists=true + summary + firstParagraph when cache present", () => {
    const project = makeProject({ default_audience: "gaming-community" });
    const invocation = {
      taskId: TASK.id,
      taskDescription: TASK.title,
      projectId: project.id,
      audience: "gaming-community",
      nAgents: 12,
      nRounds: 5,
    };
    const key = hashInvocation(invocation);
    const body = "## Reaction arc\n\nAudience skeptical on price. Grognard subcluster referenced SPI #46.\n\n## Factions\n\nOther content.";
    writeFileSync(join(tmpDir, `${key}.md`), body);

    const result = lookupCachedPreview(TASK, project, { cacheDir: tmpDir });
    expect(result.exists).toBe(true);
    expect(result.summary).toBe(body);
    expect(result.firstParagraph).toContain("Audience skeptical");
    expect(result.firstParagraph).toContain("SPI #46");
  });

  it("respects custom n_agents / n_rounds when computing the cache key", () => {
    const projectA = makeProject({
      default_audience: "gaming-community",
      n_agents: 12,
      n_rounds: 5,
    });
    const projectB = makeProject({
      default_audience: "gaming-community",
      n_agents: 4,
      n_rounds: 2,
    });
    // Put a cache file at projectA's key. projectB should NOT find it.
    const invA = {
      taskId: TASK.id,
      taskDescription: TASK.title,
      projectId: projectA.id,
      audience: "gaming-community",
      nAgents: 12,
      nRounds: 5,
    };
    writeFileSync(join(tmpDir, `${hashInvocation(invA)}.md`), "cached A");

    const resultA = lookupCachedPreview(TASK, projectA, { cacheDir: tmpDir });
    const resultB = lookupCachedPreview(TASK, projectB, { cacheDir: tmpDir });
    expect(resultA.exists).toBe(true);
    expect(resultB.exists).toBe(false);
  });
});
