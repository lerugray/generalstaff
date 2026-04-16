// Isolated test helper: proves that executeCycle runs verification and
// reviewer even when the engineer exits with a non-zero code.
//
// This runs in a subprocess so that mock.module calls don't leak into
// other test files. Exits 0 and prints JSON on success, exits 1 on failure.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { ProjectConfig, DispatcherConfig } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "cycle_test");
const PROJ_DIR = join(TEST_DIR, "proj");

let verificationCalled = false;
let reviewerCalled = false;

// --- Module mocks (safe here — isolated subprocess) ---

mock.module("../../src/engineer", () => ({
  runEngineer: async (project: ProjectConfig) => {
    // Create a real commit so the cycle sees a non-empty diff
    writeFileSync(join(project.path, "bot-output.txt"), "engineer output\n");
    await $`git -C ${project.path} add bot-output.txt`.quiet();
    await $`git -C ${project.path} commit -m "mock engineer commit"`.quiet();
    return {
      exitCode: 1,
      durationSeconds: 3,
      timedOut: false,
      logPath: join(TEST_DIR, "engineer.log"),
    };
  },
}));

mock.module("../../src/verification", () => ({
  runVerification: async () => {
    verificationCalled = true;
    return {
      outcome: "passed",
      exitCode: 0,
      durationSeconds: 1,
      logPath: join(TEST_DIR, "verification.log"),
    };
  },
}));

mock.module("../../src/reviewer", () => ({
  runReviewer: async () => {
    reviewerCalled = true;
    return {
      verdict: "verified",
      response: {
        verdict: "verified",
        reason: "Mock review passed",
        scope_drift_files: [],
        hands_off_violations: [],
        task_evidence: [],
        silent_failures: [],
        notes: "",
      },
      rawResponse: "{}",
      parseError: null,
    };
  },
}));

mock.module("../../src/safety", () => ({
  isStopFilePresent: async () => false,
  isBotRunning: () => ({ running: false }),
  isWorkingTreeClean: async () => ({ clean: true }),
}));

mock.module("../../src/state", () => ({
  ensureCycleDir: () => {
    const dir = join(TEST_DIR, "cycle-out");
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  writeCycleFile: async () => {},
  loadProjectState: async (projectId: string) => ({
    project_id: projectId,
    current_cycle_id: null,
    last_cycle_id: null,
    last_cycle_outcome: null,
    last_cycle_at: null,
    cycles_this_session: 0,
  }),
  saveProjectState: async () => {},
  loadFleetState: async () => ({
    version: 1,
    updated_at: new Date().toISOString(),
    projects: {},
  }),
  saveFleetState: async () => {},
  updateProjectFleetState: () => {},
  getRootDir: () => TEST_DIR,
}));

mock.module("../../src/audit", () => ({
  appendProgress: async () => {},
}));

const { executeCycle } = await import("../../src/cycle");

// --- Test setup ---

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(PROJ_DIR, { recursive: true });

    // Set up a real git repo for cycle.ts git commands
    await $`git -C ${PROJ_DIR} init`.quiet();
    await $`git -C ${PROJ_DIR} config user.email "test@test.com"`.quiet();
    await $`git -C ${PROJ_DIR} config user.name "Test"`.quiet();
    writeFileSync(join(PROJ_DIR, "README.md"), "initial\n");
    await $`git -C ${PROJ_DIR} add README.md`.quiet();
    await $`git -C ${PROJ_DIR} commit -m "initial commit"`.quiet();
    await $`git -C ${PROJ_DIR} checkout -b bot/work`.quiet();

    const project: ProjectConfig = {
      id: "test-proj",
      path: PROJ_DIR,
      priority: 1,
      engineer_command: "echo ok",
      verification_command: "echo ok",
      cycle_budget_minutes: 25,
      work_detection: "tasks_json",
      concurrency_detection: "none",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
    };

    const config: DispatcherConfig = {
      state_dir: join(TEST_DIR, "state"),
      fleet_state_file: "fleet_state.json",
      stop_file: "STOP",
      override_file: "OVERRIDE",
      picker: "priority_staleness",
      max_cycles_per_project_per_session: 3,
      log_dir: "logs",
      digest_dir: "digests",
    };

    const result = await executeCycle(project, config);

    const output = {
      pass: true,
      engineer_exit_code: result.engineer_exit_code,
      verification_called: verificationCalled,
      reviewer_called: reviewerCalled,
      verification_outcome: result.verification_outcome,
      reviewer_verdict: result.reviewer_verdict,
      final_outcome: result.final_outcome,
    };

    // Validate assertions
    const errors: string[] = [];
    if (result.engineer_exit_code !== 1) errors.push(`engineer_exit_code: expected 1, got ${result.engineer_exit_code}`);
    if (!verificationCalled) errors.push("verification was NOT called");
    if (!reviewerCalled) errors.push("reviewer was NOT called");
    if (result.verification_outcome !== "passed") errors.push(`verification_outcome: expected "passed", got "${result.verification_outcome}"`);
    if (result.reviewer_verdict !== "verified") errors.push(`reviewer_verdict: expected "verified", got "${result.reviewer_verdict}"`);
    if (result.final_outcome !== "verified") errors.push(`final_outcome: expected "verified", got "${result.final_outcome}"`);

    if (errors.length > 0) {
      output.pass = false;
      console.error("Assertion failures:\n" + errors.join("\n"));
    }

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
