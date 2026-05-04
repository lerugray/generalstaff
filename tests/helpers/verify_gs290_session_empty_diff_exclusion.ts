// gs-290: session-local empty-diff task exclusion — subprocess helper.
// Proves executeCycle receives prior cycle's attempted_task_id in the
// session-excluded set on the next chained cycle, and that a new runSession
// starts with no exclusions.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import type { ProjectConfig, DispatcherConfig, CycleResult } from "../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  "session_gs290_exclusion_test",
);

const tasksJson = JSON.stringify([
  { id: "task-a", title: "A", status: "pending", priority: 1 },
  { id: "task-b", title: "B", status: "pending", priority: 1 },
]);

const excludeArgs: (ReadonlySet<string> | undefined)[] = [];

const project = makeProjectConfig({
  path: TEST_DIR,
  verification_command: "bun test",
  cycle_budget_minutes: 1,
});

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [project],
    dispatcher: makeDispatcherConfig({
      state_dir: join(TEST_DIR, "state"),
      max_cycles_per_project_per_session: 100,
    }),
  }),
}));

let executeCycleCalls = 0;

mock.module("../../src/cycle", () => ({
  countCommitsAhead: async () => 0,
  executeCycle: async (
    _p: ProjectConfig,
    _c: DispatcherConfig,
    _dry: boolean,
    _rev?: string,
    sessionExcludedTaskIds?: ReadonlySet<string>,
  ): Promise<CycleResult> => {
    executeCycleCalls++;
    excludeArgs.push(sessionExcludedTaskIds);
    const now = new Date().toISOString();
    if (executeCycleCalls === 1) {
      return {
        cycle_id: "c1",
        project_id: "test-proj",
        started_at: now,
        ended_at: now,
        cycle_start_sha: "abc",
        cycle_end_sha: "abc",
        engineer_exit_code: 0,
        verification_outcome: "weak",
        reviewer_verdict: "verified_weak",
        final_outcome: "verified_weak",
        reason: "empty diff, skipping verification and reviewer",
        attempted_task_id: "task-a",
      };
    }
    return {
      cycle_id: "c2",
      project_id: "test-proj",
      started_at: now,
      ended_at: now,
      cycle_start_sha: "abc",
      cycle_end_sha: "def",
      engineer_exit_code: 0,
      verification_outcome: "passed",
      reviewer_verdict: "verified",
      final_outcome: "verified",
      reason: "ok",
      attempted_task_id: "task-b",
    };
  },
}));

let shouldChainCalls = 0;

mock.module("../../src/dispatcher", () => ({
  pickNextProject: async () => ({ project, reason: "test pick" }),
  pickNextProjects: async () => [],
  shouldChain: async () => {
    shouldChainCalls++;
    if (shouldChainCalls === 1) return { chain: true, reason: "more work" };
    return { chain: false, reason: "test stop" };
  },
  estimateSessionPlan: () => ({
    picks: [],
    per_project: [],
    total_cycles: 0,
    budget_used_minutes: 0,
    budget_remaining_minutes: 0,
  }),
}));

mock.module("../../src/safety", () => ({
  isStopFilePresent: async () => false,
}));

mock.module("../../src/state", () => ({
  loadFleetState: async () => ({
    version: 1,
    updated_at: new Date().toISOString(),
    projects: {},
  }),
  saveFleetState: async () => {},
  loadProjectState: async (id: string) => ({
    project_id: id,
    current_cycle_id: null,
    last_cycle_id: null,
    last_cycle_outcome: null,
    last_cycle_at: null,
    cycles_this_session: 0,
  }),
  saveProjectState: async () => {},
  getRootDir: () => TEST_DIR,
  botWorktreePath: (proj: { path: string }) => join(proj.path, ".bot-worktree"),
}));

mock.module("../../src/audit", () => ({
  appendProgress: async () => {},
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

mock.module("../../src/work_detection", () => ({
  countRemainingWork: async () => 2,
}));

const { runSession } = await import("../../src/session");

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "state", "test-proj"), { recursive: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });
    writeFileSync(join(TEST_DIR, "state", "test-proj", "tasks.json"), tasksJson);

    await runSession({ budgetMinutes: 60, dryRun: true, maxCycles: 2 });

    const errors: string[] = [];
    if (executeCycleCalls !== 2) {
      errors.push(`expected 2 executeCycle calls, got ${executeCycleCalls}`);
    }
    const session1Exclude = excludeArgs.map((x) =>
      x === undefined ? null : [...x],
    );
    if (excludeArgs.length !== 2) {
      errors.push(`expected 2 exclusion snapshots, got ${excludeArgs.length}`);
    } else {
      if (excludeArgs[0] !== undefined) {
        errors.push(`cycle 1: expected undefined exclusion, got ${String(excludeArgs[0])}`);
      }
      const s1 = excludeArgs[1];
      if (!s1 || !s1.has("task-a") || s1.size !== 1) {
        errors.push(
          `cycle 2: expected Set with task-a only, got ${s1 ? [...s1].join(",") : "undefined"}`,
        );
      }
    }

    executeCycleCalls = 0;
    excludeArgs.length = 0;
    shouldChainCalls = 0;

    await runSession({ budgetMinutes: 60, dryRun: true, maxCycles: 1 });

    if (executeCycleCalls !== 1) {
      errors.push(`session2: expected 1 executeCycle call, got ${executeCycleCalls}`);
    }
    const session2Exclude = excludeArgs.map((x) =>
      x === undefined ? null : [...x],
    );
    if (excludeArgs.length !== 1 || excludeArgs[0] !== undefined) {
      errors.push(
        `session2: expected fresh undefined exclusion, got ${JSON.stringify(session2Exclude)}`,
      );
    }

    const output = {
      pass: errors.length === 0,
      errors,
      session1_exclude_args: session1Exclude,
      session2_exclude_args: session2Exclude,
    };
    console.log(JSON.stringify(output));
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
