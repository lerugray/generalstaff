// Isolated test helper: proves runSession emits a cycle-completion log
// line with the expected "Cycle N completed: <project> — <outcome>
// (<remaining> remaining)" format.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "session_completion_log_test");

let pickCalls = 0;
let executeCycleCalls = 0;

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
      max_cycles_per_project_per_session: 100,
      log_dir: "logs",
      digest_dir: "digests",
    },
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
      cycle_end_sha: "def",
      engineer_exit_code: 0,
      verification_outcome: "passed",
      reviewer_verdict: "verified",
      final_outcome: "verified",
      reason: "ok",
    };
  },
}));

mock.module("../../src/dispatcher", () => ({
  pickNextProject: async () => {
    pickCalls++;
    if (pickCalls === 1) return { project, reason: "test pick" };
    return null;
  },
  shouldChain: async () => ({ chain: false, reason: "stop after one" }),
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
}));

mock.module("../../src/work_detection", () => ({
  countRemainingWork: async () => 0,
}));

const { runSession } = await import("../../src/session");

async function run() {
  // Capture console.log into a buffer while still allowing the final
  // JSON result line to reach stdout. We restore before emitting the
  // result so the parent test harness can parse the last stdout line.
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };

  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

    const results = await runSession({ budgetMinutes: 60, dryRun: true });

    console.log = origLog;

    const joined = captured.join("\n");
    const errors: string[] = [];

    const regex =
      /Cycle 1 completed: test-proj \u2014 verified \([^)]+ remaining\)/;
    if (!regex.test(joined)) {
      errors.push(
        `expected cycle completion log line matching regex, output was:\n${joined}`,
      );
    }
    if (executeCycleCalls !== 1) {
      errors.push(`expected 1 executeCycle call, got ${executeCycleCalls}`);
    }
    if (results.length !== 1) {
      errors.push(`expected 1 cycle result, got ${results.length}`);
    }

    const output = {
      pass: errors.length === 0,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      captured: joined,
      errors,
    };
    console.log(JSON.stringify(output));
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.log = origLog;
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
