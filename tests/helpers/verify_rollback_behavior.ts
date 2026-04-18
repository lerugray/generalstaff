// Isolated test helper for gs-132 rollback behavior. Argv[2] selects
// the scenario:
//   "verified"             -> reviewer verified, engineer commits, no rollback
//   "verified_weak"        -> reviewer verified_weak, engineer commits, no rollback
//   "verification_failed"  -> reviewer verification_failed, engineer commits, rollback fires
//   "empty_diff"           -> engineer makes no commits, outcome verified_weak, no rollback

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { ProjectConfig, DispatcherConfig, ReviewerVerdict } from "../../src/types";

const scenario = process.argv[2] ?? "verified";

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  `cycle_test_rollback_${scenario}`,
);
const PROJ_DIR = join(TEST_DIR, "proj");

type ProgressEvent = {
  event: string;
  data: Record<string, unknown>;
  cycle_id?: string;
};
const progressEvents: ProgressEvent[] = [];
let reviewerCalled = false;

const engineerCommits = scenario !== "empty_diff";
const reviewerVerdict: ReviewerVerdict =
  scenario === "verification_failed"
    ? "verification_failed"
    : scenario === "verified_weak"
      ? "verified_weak"
      : "verified";

mock.module("../../src/engineer", () => ({
  runEngineer: async (project: ProjectConfig) => {
    if (engineerCommits) {
      writeFileSync(join(project.path, "bot-output.txt"), "engineer output\n");
      await $`git -C ${project.path} add bot-output.txt`.quiet();
      await $`git -C ${project.path} commit -m "mock engineer commit"`.quiet();
    }
    return {
      exitCode: 0,
      durationSeconds: 3,
      timedOut: false,
      logPath: join(TEST_DIR, "engineer.log"),
    };
  },
}));

mock.module("../../src/verification", () => ({
  runVerification: async () => ({
    outcome: reviewerVerdict === "verification_failed" ? "passed" : "passed",
    exitCode: 0,
    durationSeconds: 1,
    logPath: join(TEST_DIR, "verification.log"),
  }),
}));

mock.module("../../src/reviewer", () => ({
  runReviewer: async () => {
    reviewerCalled = true;
    return {
      verdict: reviewerVerdict,
      response: {
        verdict: reviewerVerdict,
        reason: `Mock review ${reviewerVerdict}`,
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
  matchesHandsOff: () => null,
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
  appendProgress: async (projectId: string, event: string, data: Record<string, unknown>, cycleId?: string) => {
    progressEvents.push({ event, data, cycle_id: cycleId });
  },
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

    // After cycle, query actual bot/work SHA from the repo
    const branchShaRaw = await $`git -C ${PROJ_DIR} rev-parse bot/work`.text();
    const branchSha = branchShaRaw.trim();

    const rollbackEvents = progressEvents.filter((e) => e.event === "cycle_rollback");

    const output = {
      scenario,
      final_outcome: result.final_outcome,
      reviewer_called: reviewerCalled,
      cycle_start_sha: result.cycle_start_sha,
      cycle_end_sha: result.cycle_end_sha,
      branch_sha_after: branchSha,
      rollback_event_count: rollbackEvents.length,
      rollback_before_sha: rollbackEvents[0]?.data?.before_sha ?? null,
      rollback_after_sha: rollbackEvents[0]?.data?.after_sha ?? null,
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
