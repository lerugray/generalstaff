// Isolated test helper: proves that runSession exits the cycle loop
// after MAX_CONSECUTIVE_EMPTY (3) consecutive empty-diff cycles.
//
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "session_emptycycle_test");

let executeCycleCalls = 0;

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

mock.module("../../src/cycle", () => ({
  // session.ts imports countCommitsAhead for the session-end auto-merge.
  // auto_merge=false here, so the code path is never taken, but the
  // import must still resolve in the mocked module.
  countCommitsAhead: async () => 0,
  executeCycle: async (p: ProjectConfig): Promise<CycleResult> => {
    executeCycleCalls++;
    const now = new Date().toISOString();
    return {
      cycle_id: `cycle-${executeCycleCalls}`,
      project_id: p.id,
      started_at: now,
      ended_at: now,
      cycle_start_sha: "abc",
      cycle_end_sha: "abc",
      engineer_exit_code: 0,
      verification_outcome: "weak",
      reviewer_verdict: "verified_weak",
      final_outcome: "verified_weak",
      reason: "empty diff, skipping verification and reviewer",
    };
  },
}));

mock.module("../../src/dispatcher", () => ({
  pickNextProject: async () => ({ project, reason: "test pick" }),
  pickNextProjects: async () => [],
  shouldChain: async () => ({ chain: true, reason: "more work" }),
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
  botWorktreePath: (project: { path: string }) => join(project.path, ".bot-worktree"),
}));

mock.module("../../src/audit", () => ({
  appendProgress: async () => {},
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

mock.module("../../src/work_detection", () => ({
  countRemainingWork: async () => 0,
}));

const { runSession } = await import("../../src/session");

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

    // Budget large enough to allow many cycles if the guard didn't fire
    const results = await runSession({ budgetMinutes: 60, dryRun: true });

    const errors: string[] = [];
    if (executeCycleCalls !== 3) {
      errors.push(`expected 3 executeCycle calls, got ${executeCycleCalls}`);
    }
    if (results.length !== 3) {
      errors.push(`expected 3 cycle results, got ${results.length}`);
    }
    for (const r of results) {
      if (r.final_outcome !== "verified_weak") {
        errors.push(`expected verified_weak outcome, got ${r.final_outcome}`);
      }
    }

    const output = {
      pass: errors.length === 0,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      errors,
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
