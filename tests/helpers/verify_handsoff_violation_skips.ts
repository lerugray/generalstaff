// Isolated test helper: proves that executeCycle skips verification and
// reviewer when the engineer touches a hands-off file, returning
// verification_failed with the violation in the reason.
//
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { ProjectConfig, DispatcherConfig } from "../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "cycle_handsoff_test");
const PROJ_DIR = join(TEST_DIR, "proj");

let verificationCalled = false;
let reviewerCalled = false;

// --- Module mocks (safe here — isolated subprocess) ---

mock.module("../../src/engineer", () => ({
  runEngineer: async (project: ProjectConfig) => {
    // Engineer modifies a hands-off file (CLAUDE.md)
    writeFileSync(join(project.path, "CLAUDE.md"), "modified by bot\n");
    await $`git -C ${project.path} add CLAUDE.md`.quiet();
    await $`git -C ${project.path} commit -m "mock engineer touches hands-off file"`.quiet();
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

// Import the real matchesHandsOff before mocking
const { matchesHandsOff: realMatchesHandsOff } = await import("../../src/safety");

mock.module("../../src/safety", () => ({
  isStopFilePresent: async () => false,
  isBotRunning: () => ({ running: false }),
  isWorkingTreeClean: async () => ({ clean: true }),
  matchesHandsOff: realMatchesHandsOff,
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

// --- Test setup ---

async function run() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(PROJ_DIR, { recursive: true });

    // Set up a real git repo
    await $`git -C ${PROJ_DIR} init`.quiet();
    await $`git -C ${PROJ_DIR} config user.email "test@test.com"`.quiet();
    await $`git -C ${PROJ_DIR} config user.name "Test"`.quiet();
    writeFileSync(join(PROJ_DIR, "README.md"), "initial\n");
    writeFileSync(join(PROJ_DIR, "CLAUDE.md"), "original content\n");
    await $`git -C ${PROJ_DIR} add .`.quiet();
    await $`git -C ${PROJ_DIR} commit -m "initial commit"`.quiet();
    await $`git -C ${PROJ_DIR} checkout -b bot/work`.quiet();

    const project = makeProjectConfig({
      path: PROJ_DIR,
      hands_off: ["CLAUDE.md", "CLAUDE-AUTONOMOUS.md"],
    });

    const config = makeDispatcherConfig({
      state_dir: join(TEST_DIR, "state"),
    });

    const result = await executeCycle(project, config);

    const output = {
      pass: true,
      verification_called: verificationCalled,
      reviewer_called: reviewerCalled,
      final_outcome: result.final_outcome,
      reason: result.reason,
    };

    // Validate assertions
    const errors: string[] = [];
    if (verificationCalled) errors.push("verification was called but should NOT have been");
    if (reviewerCalled) errors.push("reviewer was called but should NOT have been");
    if (result.final_outcome !== "verification_failed") {
      errors.push(`final_outcome: expected "verification_failed", got "${result.final_outcome}"`);
    }
    if (!result.reason.includes("hands-off violation")) {
      errors.push(`reason should mention "hands-off violation", got: "${result.reason}"`);
    }
    if (!result.reason.includes("CLAUDE.md")) {
      errors.push(`reason should mention "CLAUDE.md", got: "${result.reason}"`);
    }

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
