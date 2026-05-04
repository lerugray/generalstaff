// gs-292: subprocess helper — runSession respects dispatcher.max_consecutive_empty,
// default 3 when unset (via makeDispatcherConfig), per-project override vs fleet,
// and parallel all-empty rounds use max limit across the round's projects.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

const mode = process.argv[2] ?? "sequential-fleet-5";

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  `session_gs292_${mode.replace(/[^a-z0-9_-]/gi, "_")}`,
);

let executeCycleCalls = 0;

const emptyWeak = (p: ProjectConfig): CycleResult => {
  const now = new Date().toISOString();
  return {
    cycle_id: `cycle-${executeCycleCalls}`,
    project_id: p.id,
    started_at: now,
    ended_at: now,
    cycle_start_sha: "abc",
    cycle_end_sha: "abc",
    engineer_exit_code: 0,
    verification_outcome: "weak",
    reviewer_verdict: "verified_weak",
    final_outcome: "verified_weak",
    reason: "empty diff, skipping verification and reviewer",
  };
};

const projectBase = makeProjectConfig({
  path: TEST_DIR,
  verification_command: "bun test",
  cycle_budget_minutes: 1,
});

let dispatcher = makeDispatcherConfig({
  state_dir: join(TEST_DIR, "state"),
  max_cycles_per_project_per_session: 100,
});
let project: ProjectConfig = projectBase;
let projectB: ProjectConfig | null = null;

if (mode === "sequential-fleet-5") {
  dispatcher = makeDispatcherConfig({
    state_dir: join(TEST_DIR, "state"),
    max_cycles_per_project_per_session: 100,
    max_consecutive_empty: 5,
  });
} else if (mode === "sequential-default-3") {
  dispatcher = makeDispatcherConfig({
    state_dir: join(TEST_DIR, "state"),
    max_cycles_per_project_per_session: 100,
    // max_consecutive_empty omitted — factory default 3
  });
} else if (mode === "sequential-project-7") {
  dispatcher = makeDispatcherConfig({
    state_dir: join(TEST_DIR, "state"),
    max_cycles_per_project_per_session: 100,
    max_consecutive_empty: 3,
  });
  project = { ...projectBase, max_consecutive_empty: 7 };
} else if (mode === "parallel-all-empty-2") {
  project = { ...projectBase, id: "proj-a" };
  projectB = { ...projectBase, id: "proj-b" };
  dispatcher = makeDispatcherConfig({
    state_dir: join(TEST_DIR, "state"),
    max_cycles_per_project_per_session: 100,
    max_parallel_slots: 2,
    max_consecutive_empty: 2,
  });
} else if (mode === "parallel-round-limit-max") {
  project = { ...projectBase, id: "proj-a", max_consecutive_empty: 4 };
  projectB = { ...projectBase, id: "proj-b" };
  dispatcher = makeDispatcherConfig({
    state_dir: join(TEST_DIR, "state"),
    max_cycles_per_project_per_session: 100,
    max_parallel_slots: 2,
    max_consecutive_empty: 2,
  });
} else {
  console.error(JSON.stringify({ pass: false, error: `unknown mode ${mode}` }));
  process.exit(1);
}

const projectsList: ProjectConfig[] =
  projectB !== null ? [project, projectB] : [project];

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: projectsList,
    dispatcher,
  }),
}));

mock.module("../../src/cycle", () => ({
  countCommitsAhead: async () => 0,
  executeCycle: async (p: ProjectConfig): Promise<CycleResult> => {
    executeCycleCalls++;
    return emptyWeak(p);
  },
}));

mock.module("../../src/dispatcher", () => ({
  pickNextProject: async () => ({ project, reason: "test pick" }),
  pickNextProjects: async (
    _projects: ProjectConfig[],
    _config: unknown,
    _fleet: unknown,
    _skip: Set<string> = new Set(),
    _max: number = 1,
    _sessionExcluded?: ReadonlyMap<string, ReadonlySet<string>>,
  ) => {
    if (projectB === null) {
      return [{ project, reason: "test" }];
    }
    return [
      { project, reason: "a" },
      { project: projectB, reason: "b" },
    ];
  },
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
  botWorktreePath: (proj: { path: string }) => join(proj.path, ".bot-worktree"),
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
    let expectedCalls = 5;
    if (mode === "sequential-default-3") expectedCalls = 3;
    if (mode === "sequential-project-7") expectedCalls = 7;
    if (mode === "parallel-all-empty-2") expectedCalls = 4;
    if (mode === "parallel-round-limit-max") expectedCalls = 8;

    if (executeCycleCalls !== expectedCalls) {
      errors.push(`expected ${expectedCalls} executeCycle calls, got ${executeCycleCalls}`);
    }
    if (results.length !== expectedCalls) {
      errors.push(`expected ${expectedCalls} results, got ${results.length}`);
    }

    const output = {
      pass: errors.length === 0,
      mode,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
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
