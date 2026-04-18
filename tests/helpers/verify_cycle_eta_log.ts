// Isolated test helper: proves runSession emits an ETA hint on the
// cycle-completion line once at least 2 cycles have completed, and
// omits it for the first cycle.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "session_eta_log_test");

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
  countCommitsAhead: async () => 0,
  executeCycle: async (p: ProjectConfig): Promise<CycleResult> => {
    executeCycleCalls++;
    // Fixed 60s cycle duration so the ETA math is deterministic.
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date().toISOString();
    return {
      cycle_id: `cycle-${executeCycleCalls}`,
      project_id: p.id,
      started_at: start,
      ended_at: end,
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
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };

  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

    // maxCycles=2 to get exactly 2 cycles — enough to exercise both the
    // pre-ETA (cycle 1, too few samples) and post-ETA (cycle 2) paths.
    const results = await runSession({
      budgetMinutes: 60,
      dryRun: true,
      maxCycles: 2,
    });

    console.log = origLog;

    const joined = captured.join("\n");
    const errors: string[] = [];

    const cycle1Line = captured.find((l) => l.includes("Cycle 1 completed"));
    const cycle2Line = captured.find((l) => l.includes("Cycle 2 completed"));

    if (!cycle1Line) {
      errors.push("missing Cycle 1 completion log line");
    } else if (cycle1Line.includes("projected end:")) {
      errors.push(
        `Cycle 1 line should not include ETA (only 1 sample), got: ${cycle1Line}`,
      );
    }

    if (!cycle2Line) {
      errors.push("missing Cycle 2 completion log line");
    } else if (!/projected end: \d{2}:\d{2}/.test(cycle2Line)) {
      errors.push(
        `Cycle 2 line should include 'projected end: HH:MM', got: ${cycle2Line}`,
      );
    }

    if (executeCycleCalls !== 2) {
      errors.push(`expected 2 executeCycle calls, got ${executeCycleCalls}`);
    }
    if (results.length !== 2) {
      errors.push(`expected 2 cycle results, got ${results.length}`);
    }

    const output = {
      pass: errors.length === 0,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      cycle1_line: cycle1Line ?? "",
      cycle2_line: cycle2Line ?? "",
      captured: joined,
      errors,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
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
