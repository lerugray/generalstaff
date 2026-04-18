// gs-131: when a STOP file is written while the engineer is running,
// executeCycle should route the cycle to cycle_skipped (not the gs-111
// abnormal-exit -> verification_failed branch). The engineer mock here
// simulates the session watcher's kill by returning exitCode=null AND
// writes the STOP file before returning, which is what the live watcher
// observes in practice.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { ProjectConfig, DispatcherConfig } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "cycle_test_stop_mid");
const PROJ_DIR = join(TEST_DIR, "proj");
const stopFilePath = join(TEST_DIR, "STOP");

let verificationCalled = false;
let reviewerCalled = false;
let stopFilePresent = false;

mock.module("../../src/engineer", () => ({
  runEngineer: async (project: ProjectConfig) => {
    writeFileSync(join(project.path, "bot-partial.txt"), "partial work\n");
    await $`git -C ${project.path} add bot-partial.txt`.quiet();
    await $`git -C ${project.path} commit -m "partial commit before stop"`.quiet();
    // Simulate the session watcher: STOP file appears, engineer dies.
    writeFileSync(stopFilePath, "stop\n", "utf8");
    stopFilePresent = true;
    return {
      exitCode: null,
      durationSeconds: 2,
      timedOut: false,
      logPath: join(TEST_DIR, "engineer.log"),
    };
  },
  killActiveEngineer: () => false,
  getActiveEngineerChild: () => null,
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
      response: null,
      rawResponse: "{}",
      parseError: null,
    };
  },
}));

mock.module("../../src/safety", () => ({
  // Only presents as true AFTER the mocked engineer "wrote" the STOP file.
  isStopFilePresent: async () => stopFilePresent,
  isBotRunning: () => ({ running: false }),
  isWorkingTreeClean: async () => ({ clean: true }),
  matchesHandsOff: () => null,
  stopFilePath: () => stopFilePath,
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
  botWorktreePath: (project: { path: string }) => join(project.path, ".bot-worktree"),
}));

mock.module("../../src/audit", () => ({
  appendProgress: async () => {},
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

const { executeCycle } = await import("../../src/cycle");

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(PROJ_DIR, { recursive: true });

    await $`git -C ${PROJ_DIR} init`.quiet();
    await $`git -C ${PROJ_DIR} config user.email "test@test.com"`.quiet();
    await $`git -C ${PROJ_DIR} config user.name "Test"`.quiet();
    await $`git -C ${PROJ_DIR} config commit.gpgsign false`.quiet();
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
      max_parallel_slots: 1,
    };

    const result = await executeCycle(project, config);

    const output = {
      engineer_exit_code: result.engineer_exit_code,
      verification_called: verificationCalled,
      reviewer_called: reviewerCalled,
      final_outcome: result.final_outcome,
      reason: result.reason,
    };

    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (err) {
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
