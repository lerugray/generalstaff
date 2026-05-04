// argv[2]: "mock-claim" — mocked engineer returns attempted_task_id (must appear on cycle_end).
// argv[2]: "fallback" — engineer omits attempted_task_id; peeked nextTask id is used on cycle_end.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { ProjectConfig, DispatcherConfig } from "../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

const mode = process.argv[2] ?? "fallback";

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  `cycle_test_attempted_task_${mode}`,
);
const PROJ_DIR = join(TEST_DIR, "proj");

let verificationCalled = false;
let reviewerCalled = false;
const progressEvents: Array<{ event: string; data: Record<string, unknown> }> =
  [];

mock.module("../../src/engineer", () => ({
  runEngineer: async (project: ProjectConfig) => {
    writeFileSync(join(project.path, "bot-output.txt"), "engineer output\n");
    await $`git -C ${project.path} add bot-output.txt`.quiet();
    await $`git -C ${project.path} commit -m "mock engineer commit"`.quiet();
    if (mode === "mock-claim") {
      return {
        exitCode: 0,
        durationSeconds: 2,
        timedOut: false,
        logPath: join(TEST_DIR, "engineer.log"),
        attempted_task_id: "from-mock-claim",
      };
    }
    return {
      exitCode: 0,
      durationSeconds: 2,
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
  matchesHandsOff: () => null,
  matchesHandsOffSymlinkAware: () => null,
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
  appendProgress: async (
    _projectId: string,
    event: string,
    data: Record<string, unknown>,
  ) => {
    progressEvents.push({ event, data });
  },
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

const { executeCycle } = await import("../../src/cycle");

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "state", "testproj"), { recursive: true });
    mkdirSync(PROJ_DIR, { recursive: true });

    writeFileSync(
      join(TEST_DIR, "state", "testproj", "tasks.json"),
      JSON.stringify(
        [
          {
            id: "peeked-001",
            title: "peek task",
            status: "pending",
            priority: 1,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    await $`git -C ${PROJ_DIR} init`.quiet();
    await $`git -C ${PROJ_DIR} config user.email "test@test.com"`.quiet();
    await $`git -C ${PROJ_DIR} config user.name "Test"`.quiet();
    await $`git -C ${PROJ_DIR} config commit.gpgsign false`.quiet();
    writeFileSync(join(PROJ_DIR, "README.md"), "initial\n");
    await $`git -C ${PROJ_DIR} add README.md`.quiet();
    await $`git -C ${PROJ_DIR} commit -m "initial commit"`.quiet();
    await $`git -C ${PROJ_DIR} checkout -b bot/work`.quiet();

    const project = makeProjectConfig({
      id: "testproj",
      path: PROJ_DIR,
    });

    const config = makeDispatcherConfig({
      state_dir: join(TEST_DIR, "state"),
    });

    const result = await executeCycle(project, config);

    const cycleEnd = progressEvents.filter((e) => e.event === "cycle_end");
    const attempted = cycleEnd[0]?.data?.attempted_task_id;

    const errors: string[] = [];
    if (cycleEnd.length !== 1) {
      errors.push(`expected 1 cycle_end, got ${cycleEnd.length}`);
    }
    if (mode === "mock-claim") {
      if (attempted !== "from-mock-claim") {
        errors.push(
          `mock-claim: attempted_task_id want from-mock-claim, got ${String(attempted)}`,
        );
      }
    } else {
      if (attempted !== "peeked-001") {
        errors.push(
          `fallback: attempted_task_id want peeked-001, got ${String(attempted)}`,
        );
      }
    }
    if (!verificationCalled) errors.push("verification should run");
    if (!reviewerCalled) errors.push("reviewer should run");
    if (result.final_outcome !== "verified") {
      errors.push(`final_outcome want verified, got ${result.final_outcome}`);
    }

    console.log(
      JSON.stringify({
        pass: errors.length === 0,
        attempted_task_id: attempted,
        errors,
      }),
    );
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

void run();
