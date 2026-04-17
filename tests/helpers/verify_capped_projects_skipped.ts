// Isolated test helper: proves that runSession adds a project to the
// skip set once it hits max_cycles_per_project_per_session, by:
//   1. running exactly max_cycles cycles before the project gets capped
//   2. observing that pickNextProject is called with skipProjectIds
//      containing the project id after the cap fires
//   3. ending the session when no other projects are eligible
//
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "session_cap_test");
const MAX_CYCLES = 2;

let executeCycleCalls = 0;
let pickCalls = 0;
const pickSkipSnapshots: string[][] = [];

const project: ProjectConfig = {
  id: "test-proj",
  path: TEST_DIR,
  priority: 1,
  engineer_command: "echo ok",
  verification_command: "bun test",
  cycle_budget_minutes: 1,
  work_detection: "tasks_json",
  concurrency_detection: "none",
  branch: "bot/work",
  auto_merge: false,
  hands_off: [],
};

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [project],
    dispatcher: {
      state_dir: join(TEST_DIR, "state"),
      fleet_state_file: "fleet_state.json",
      stop_file: "STOP",
      override_file: "OVERRIDE",
      picker: "priority_staleness",
      max_cycles_per_project_per_session: MAX_CYCLES,
      log_dir: "logs",
      digest_dir: "digests",
    },
  }),
}));

mock.module("../../src/cycle", () => ({
  // session.ts imports countCommitsAhead for the session-end auto-merge.
  // This helper's project has auto_merge=false so the code path is never
  // taken, but the import must still resolve in the mocked module.
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
      cycle_end_sha: "def",
      engineer_exit_code: 0,
      verification_outcome: "passed",
      reviewer_verdict: "verified",
      final_outcome: "verified",
      reason: "tests pass",
    };
  },
}));

mock.module("../../src/dispatcher", () => ({
  pickNextProject: async (
    _projects: ProjectConfig[],
    _config: unknown,
    _fleet: unknown,
    skipProjectIds: Set<string> = new Set(),
  ) => {
    pickCalls++;
    pickSkipSnapshots.push([...skipProjectIds]);
    if (skipProjectIds.has(project.id)) {
      return null; // capped — no other projects available
    }
    return { project, reason: "test pick" };
  },
  // Real shouldChain logic (without hasMoreWork side effect) — chain until cap
  shouldChain: async (
    _last: CycleResult,
    _project: ProjectConfig,
    cyclesOnProject: number,
    maxCyclesPerProject: number,
  ) => {
    if (cyclesOnProject >= maxCyclesPerProject) {
      return { chain: false, reason: "per-project cycle cap reached" };
    }
    return { chain: true, reason: "more work, budget ok, last cycle passed" };
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

    const results = await runSession({ budgetMinutes: 60, dryRun: true });

    const errors: string[] = [];
    if (executeCycleCalls !== MAX_CYCLES) {
      errors.push(
        `expected ${MAX_CYCLES} executeCycle calls, got ${executeCycleCalls}`,
      );
    }
    if (results.length !== MAX_CYCLES) {
      errors.push(
        `expected ${MAX_CYCLES} cycle results, got ${results.length}`,
      );
    }
    // The first pick happens before any cap. After cycle MAX_CYCLES, the
    // project should be added to skipProjectIds and pickNextProject should be
    // called again with that set populated.
    const lastSnap = pickSkipSnapshots[pickSkipSnapshots.length - 1] ?? [];
    if (!lastSnap.includes(project.id)) {
      errors.push(
        `last pickNextProject call did not see project in skip set; ` +
          `snapshots=${JSON.stringify(pickSkipSnapshots)}`,
      );
    }
    if (pickCalls < 2) {
      errors.push(
        `expected at least 2 pickNextProject calls (initial + after cap), got ${pickCalls}`,
      );
    }

    const output = {
      pass: errors.length === 0,
      execute_cycle_calls: executeCycleCalls,
      pick_calls: pickCalls,
      result_count: results.length,
      pick_skip_snapshots: pickSkipSnapshots,
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
