// Isolated test helper: proves that runSession honors the maxCycles
// option, stopping after exactly that many cycles even when the budget
// would otherwise allow more.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "session_maxcycles_test");

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
  pickNextProject: async () => ({ project, reason: "test pick" }),
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
  const mode = process.argv[2] ?? "max-cycles-hits-first";
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

    // Capture console.log output to verify the stop reason message
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...parts: unknown[]) => {
      captured.push(parts.join(" "));
    };

    let results: CycleResult[];
    try {
      if (mode === "max-cycles-hits-first") {
        // Large budget, small maxCycles — maxCycles should trigger
        results = await runSession({
          budgetMinutes: 60,
          dryRun: true,
          maxCycles: 2,
        });
      } else if (mode === "budget-hits-first") {
        // Tiny budget, large maxCycles — budget should trigger.
        // cycle_budget_minutes=1 + 5 = 6 needed; budget of 3 short-circuits
        // before the first cycle, producing 0 results.
        results = await runSession({
          budgetMinutes: 3,
          dryRun: true,
          maxCycles: 100,
        });
      } else {
        // default — no maxCycles given
        results = await runSession({
          budgetMinutes: 3,
          dryRun: true,
        });
      }
    } finally {
      console.log = origLog;
    }

    const errors: string[] = [];
    if (mode === "max-cycles-hits-first") {
      if (executeCycleCalls !== 2) {
        errors.push(`expected 2 executeCycle calls, got ${executeCycleCalls}`);
      }
      if (results.length !== 2) {
        errors.push(`expected 2 results, got ${results.length}`);
      }
      const joined = captured.join("\n");
      if (!joined.includes("Max-cycles limit reached (2)")) {
        errors.push("missing max-cycles log message");
      }
      if (!joined.includes("Stop reason: max-cycles")) {
        errors.push("stop reason was not 'max-cycles'");
      }
    } else if (mode === "budget-hits-first") {
      if (executeCycleCalls !== 0) {
        errors.push(`expected 0 executeCycle calls, got ${executeCycleCalls}`);
      }
      const joined = captured.join("\n");
      if (!joined.includes("Stop reason: insufficient-budget")) {
        errors.push("stop reason was not 'insufficient-budget'");
      }
    } else {
      // default — no maxCycles: same shape as budget-hits-first but must
      // not print max-cycles config line in header
      const joined = captured.join("\n");
      if (joined.includes("Max cycles:")) {
        errors.push("header should not mention max cycles when not set");
      }
      if (!joined.includes("Stop reason:")) {
        errors.push("missing Stop reason line");
      }
    }

    const output = {
      pass: errors.length === 0,
      mode,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      captured: captured.join("\n"),
      errors,
    };
    // eslint-disable-next-line no-console
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
