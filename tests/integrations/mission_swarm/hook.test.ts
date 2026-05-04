// gs-306: tests for the mission-swarm reviewer preview hook.
// Uses bun:test; mocks the subprocess layer via RunPreviewOptions.runSim
// + runSummarize injection so the tests don't spawn Bun or hit the
// real mission-swarm repo. Cache dir is a per-test temp dir under
// tests/fixtures/.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  hashInvocation,
  runMissionSwarmPreview,
} from "../../../src/integrations/mission_swarm/hook";
import type { SubprocessResult } from "../../../src/integrations/mission_swarm/subprocess";
import type {
  GreenfieldTask,
  ProjectConfig,
} from "../../../src/types";

const BASE_TASK: GreenfieldTask = {
  id: "wdb-042",
  title: "Launch WDB hardcopy at $20 with draft README framing",
  status: "pending",
  priority: 1,
};

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
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
    missionswarm: {
      default_audience: "gaming-community",
      n_agents: 4,
      n_rounds: 2,
    },
    ...overrides,
  };
}

let tmpRoot: string;
let cacheDir: string;
let fakeMsRoot: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `gs-ms-hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  cacheDir = join(tmpRoot, "cache");
  fakeMsRoot = join(tmpRoot, "fake-ms");
  mkdirSync(join(fakeMsRoot, "src"), { recursive: true });
  writeFileSync(join(fakeMsRoot, "src", "index.ts"), "// fake");
  mkdirSync(cacheDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("runMissionSwarmPreview", () => {
  it("skips with no_config when project.missionswarm is missing", async () => {
    const project = makeProject({ missionswarm: undefined });
    const result = await runMissionSwarmPreview(BASE_TASK, project, {
      cacheDir,
      missionswarmRoot: fakeMsRoot,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("no_config");
    expect(result.summary).toBeNull();
  });

  it("skips when MISSIONSWARM_ROOT cannot be resolved", async () => {
    const project = makeProject();
    const bogusRoot = join(tmpRoot, "does-not-exist");
    const result = await runMissionSwarmPreview(BASE_TASK, project, {
      cacheDir,
      missionswarmRoot: bogusRoot,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("missionswarm_root_not_found");
  });

  it("returns a fresh preview and writes the cache on miss", async () => {
    const project = makeProject();
    let simCalls = 0;
    let summarizeCalls = 0;
    const simResult: SubprocessResult = {
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    const summarizeResult: SubprocessResult = {
      ok: true,
      stdout: "## Reaction arc\n\nThe community pushed back on the $20 price point.",
      stderr: "",
      exitCode: 0,
    };

    const result = await runMissionSwarmPreview(BASE_TASK, project, {
      cacheDir,
      missionswarmRoot: fakeMsRoot,
      runSim: async () => {
        simCalls++;
        return simResult;
      },
      runSummarize: async () => {
        summarizeCalls++;
        return summarizeResult;
      },
    });

    expect(simCalls).toBe(1);
    expect(summarizeCalls).toBe(1);
    expect(result.skipped).toBe(false);
    expect(result.cacheHit).toBe(false);
    expect(result.summary).toContain("Reaction arc");

    const invocation = {
      taskId: BASE_TASK.id,
      taskDescription: BASE_TASK.title,
      projectId: project.id,
      audience: "gaming-community",
      nAgents: 4,
      nRounds: 2,
    };
    const key = hashInvocation(invocation);
    expect(existsSync(join(cacheDir, `${key}.md`))).toBe(true);
    const onDisk = await readFile(join(cacheDir, `${key}.md`), "utf8");
    expect(onDisk).toContain("Reaction arc");
  });

  it("returns the cached summary on the second call without spawning", async () => {
    const project = makeProject();
    const invocation = {
      taskId: BASE_TASK.id,
      taskDescription: BASE_TASK.title,
      projectId: project.id,
      audience: "gaming-community",
      nAgents: 4,
      nRounds: 2,
    };
    const key = hashInvocation(invocation);
    writeFileSync(join(cacheDir, `${key}.md`), "cached summary body");

    let spawned = 0;
    const result = await runMissionSwarmPreview(BASE_TASK, project, {
      cacheDir,
      missionswarmRoot: fakeMsRoot,
      runSim: async () => {
        spawned++;
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      },
      runSummarize: async () => {
        spawned++;
        return { ok: true, stdout: "fresh", stderr: "", exitCode: 0 };
      },
    });

    expect(spawned).toBe(0);
    expect(result.cacheHit).toBe(true);
    expect(result.summary).toBe("cached summary body");
  });

  // gs-309: description (task.title → invocation.taskDescription) is in the
  // sha256 cache basis; editing it must miss the old cache file, re-spawn,
  // and write a new key.md. The X cache file remains on disk until GC.
  it("cache miss when task title changes X → Y (distinct sha256 keys, fresh preview)", async () => {
    const project = makeProject();
    const taskX: GreenfieldTask = { ...BASE_TASK, title: "X" };
    const taskY: GreenfieldTask = { ...BASE_TASK, title: "Y" };
    const audience = "gaming-community";
    const nAgents = 4;
    const nRounds = 2;
    const invocationX = {
      taskId: taskX.id,
      taskDescription: "X",
      projectId: project.id,
      audience,
      nAgents,
      nRounds,
    };
    const invocationY = { ...invocationX, taskDescription: "Y" };
    const keyX = hashInvocation(invocationX);
    const keyY = hashInvocation(invocationY);
    expect(keyX).not.toBe(keyY);

    let simCalls = 0;
    let summarizeCalls = 0;

    const runFresh = async (task: GreenfieldTask, summaryLine: string) =>
      runMissionSwarmPreview(task, project, {
        cacheDir,
        missionswarmRoot: fakeMsRoot,
        runSim: async () => {
          simCalls++;
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
        runSummarize: async () => {
          summarizeCalls++;
          return { ok: true, stdout: summaryLine, stderr: "", exitCode: 0 };
        },
      });

    const rX = await runFresh(taskX, "## Preview for X\n");
    expect(rX.cacheHit).toBe(false);
    expect(rX.skipped).toBe(false);
    expect(rX.summary).toContain("Preview for X");
    expect(simCalls).toBe(1);
    expect(summarizeCalls).toBe(1);

    const rY = await runFresh(taskY, "## Preview for Y\n");
    expect(rY.cacheHit).toBe(false);
    expect(rY.skipped).toBe(false);
    expect(rY.summary).toContain("Preview for Y");
    expect(rY.summary).not.toContain("Preview for X");
    expect(simCalls).toBe(2);
    expect(summarizeCalls).toBe(2);

    expect(existsSync(join(cacheDir, `${keyX}.md`))).toBe(true);
    expect(existsSync(join(cacheDir, `${keyY}.md`))).toBe(true);
    expect(await readFile(join(cacheDir, `${keyX}.md`), "utf8")).toContain("Preview for X");
    expect(await readFile(join(cacheDir, `${keyY}.md`), "utf8")).toContain("Preview for Y");
  });

  it("graceful-skips when `missionswarm run` subprocess fails", async () => {
    const project = makeProject();
    const result = await runMissionSwarmPreview(BASE_TASK, project, {
      cacheDir,
      missionswarmRoot: fakeMsRoot,
      runSim: async () => ({
        ok: false,
        stdout: "",
        stderr: "boom",
        exitCode: 1,
        error: "nonzero exit",
      }),
      runSummarize: async () => {
        throw new Error("summarize should not run after sim failure");
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("subprocess_failed");
  });

  it("graceful-skips when summarize returns no stdout", async () => {
    const project = makeProject();
    const result = await runMissionSwarmPreview(BASE_TASK, project, {
      cacheDir,
      missionswarmRoot: fakeMsRoot,
      runSim: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
      runSummarize: async () => ({ ok: true, stdout: "   \n", stderr: "", exitCode: 0 }),
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("summary_missing");
  });
});
