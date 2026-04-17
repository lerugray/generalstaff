// Isolated test helper: proves runSession honors the excludeProjects
// option by (1) seeding the skip set passed to pickNextProject with the
// excluded ids, (2) warning (not erroring) on unknown ids, and (3)
// ending with stop_reason="no-project" when every eligible project is
// excluded.
//
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const scenario = process.argv[2];
if (!scenario) {
  console.error("scenario arg required: single|multiple|all-excluded|unknown-id");
  process.exit(1);
}

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  `session_exclude_${scenario}_test`,
);

const makeProject = (id: string): ProjectConfig => ({
  id,
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
});

const projects: ProjectConfig[] = [
  makeProject("alpha"),
  makeProject("beta"),
  makeProject("gamma"),
];

let executeCycleCalls = 0;
const pickSkipSnapshots: string[][] = [];
const pickedIds: string[] = [];

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects,
    dispatcher: {
      state_dir: join(TEST_DIR, "state"),
      fleet_state_file: "fleet_state.json",
      stop_file: "STOP",
      override_file: "OVERRIDE",
      picker: "priority_staleness",
      max_cycles_per_project_per_session: 1,
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
  pickNextProject: async (
    availableProjects: ProjectConfig[],
    _config: unknown,
    _fleet: unknown,
    skipProjectIds: Set<string> = new Set(),
  ) => {
    pickSkipSnapshots.push([...skipProjectIds]);
    const pick = availableProjects.find(
      (p) => !skipProjectIds.has(p.id),
    );
    if (!pick) return null;
    pickedIds.push(pick.id);
    return { project: pick, reason: "test pick" };
  },
  // Return cap-reached so session.ts adds the current project to the skip
  // set after each cycle (the loop would otherwise keep re-picking the same
  // project since our stubbed executeCycle returns "verified", not "skipped").
  shouldChain: async () => ({
    chain: false,
    reason: "per-project cycle cap reached",
  }),
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

mock.module("../../src/notify", () => ({
  notifySessionEnd: async () => {},
}));

const { runSession } = await import("../../src/session");

async function run() {
  const origLog = console.log;
  const origWarn = console.warn;
  const warnMessages: string[] = [];
  const logMessages: string[] = [];
  console.log = (...args: unknown[]) => {
    logMessages.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warnMessages.push(args.map(String).join(" "));
  };

  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

    let excludeProjects: string[] = [];
    switch (scenario) {
      case "single":
        excludeProjects = ["alpha"];
        break;
      case "multiple":
        excludeProjects = ["alpha", "beta"];
        break;
      case "all-excluded":
        excludeProjects = ["alpha", "beta", "gamma"];
        break;
      case "unknown-id":
        excludeProjects = ["does-not-exist"];
        break;
    }

    const results = await runSession({
      budgetMinutes: 60,
      dryRun: true,
      excludeProjects,
    });

    console.log = origLog;
    console.warn = origWarn;

    const errors: string[] = [];
    const firstSnap = pickSkipSnapshots[0] ?? [];

    if (scenario === "single") {
      if (!firstSnap.includes("alpha")) {
        errors.push(
          `first pickNextProject skip set missing "alpha": ${JSON.stringify(firstSnap)}`,
        );
      }
      if (pickedIds.includes("alpha")) {
        errors.push(`"alpha" was picked despite being excluded`);
      }
      if (pickedIds.length === 0) {
        errors.push(`no projects were picked (expected beta and/or gamma)`);
      }
    } else if (scenario === "multiple") {
      if (!firstSnap.includes("alpha") || !firstSnap.includes("beta")) {
        errors.push(
          `first pickNextProject skip set missing alpha and/or beta: ${JSON.stringify(firstSnap)}`,
        );
      }
      if (pickedIds.some((id) => id === "alpha" || id === "beta")) {
        errors.push(`excluded project was picked: ${JSON.stringify(pickedIds)}`);
      }
    } else if (scenario === "all-excluded") {
      if (results.length !== 0) {
        errors.push(`expected 0 cycles when all projects excluded, got ${results.length}`);
      }
      if (executeCycleCalls !== 0) {
        errors.push(`expected 0 executeCycle calls, got ${executeCycleCalls}`);
      }
      if (!logMessages.some((m) => m.includes("No eligible project"))) {
        errors.push(
          `expected "No eligible project" log message; logs=${JSON.stringify(logMessages)}`,
        );
      }
    } else if (scenario === "unknown-id") {
      if (!warnMessages.some((m) => m.includes("does-not-exist"))) {
        errors.push(
          `expected warning mentioning unknown id; warns=${JSON.stringify(warnMessages)}`,
        );
      }
      // Session should still run normally against the real projects
      if (pickedIds.length === 0) {
        errors.push(`no projects were picked — unknown id should not halt the session`);
      }
    }

    const output = {
      pass: errors.length === 0,
      scenario,
      execute_cycle_calls: executeCycleCalls,
      picked_ids: pickedIds,
      first_skip_snapshot: firstSnap,
      warn_messages: warnMessages,
      errors,
    };
    console.log(JSON.stringify(output));
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.log = origLog;
    console.warn = origWarn;
    console.error("Test helper crashed:", err);
    process.exit(1);
  } finally {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

run();
