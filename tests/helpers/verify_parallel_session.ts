// Isolated test helper: proves that runSession, when
// dispatcher.max_parallel_slots > 1, runs cycles in parallel
// (Promise.all over the picks) and emits the slot_idle / round
// metrics in session_complete. Also pins that chaining is
// disabled in parallel mode — each round picks fresh from the
// picker.
//
// Runs in a subprocess so mock.module calls don't leak.

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";

const TEST_DIR = join(import.meta.dir, "..", "fixtures", "parallel_session_test");

let executeCycleCalls = 0;
const executeCycleOverlap: Array<{ project: string; startMs: number; endMs: number }> = [];
let pickNextProjectsCalls = 0;
let pickNextProjectCalls = 0; // must stay 0 in parallel mode
let sessionCompleteEvent: Record<string, unknown> | null = null;

const projectA: ProjectConfig = {
  id: "proj-a",
  path: TEST_DIR,
  priority: 1,
  engineer_command: "echo a",
  verification_command: "echo",
  cycle_budget_minutes: 1,
  work_detection: "tasks_json",
  concurrency_detection: "none",
  branch: "bot/work",
  auto_merge: false,
  hands_off: [],
};
const projectB: ProjectConfig = { ...projectA, id: "proj-b" };

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [projectA, projectB],
    dispatcher: {
      state_dir: join(TEST_DIR, "state"),
      fleet_state_file: "fleet_state.json",
      stop_file: "STOP",
      override_file: "OVERRIDE",
      picker: "priority_staleness",
      max_cycles_per_project_per_session: 1, // 1 cycle per project → session ends after one round
      log_dir: "logs",
      digest_dir: "digests",
      max_parallel_slots: 2,
    },
  }),
}));

mock.module("../../src/cycle", () => ({
  countCommitsAhead: async () => 0,
  executeCycle: async (p: ProjectConfig): Promise<CycleResult> => {
    executeCycleCalls++;
    const startMs = Date.now();
    // 50ms cycle per slot. In parallel mode, both Promise.all siblings
    // should overlap — the recorder below captures each slot's
    // [start, end] interval so the assert can check overlap.
    await new Promise((r) => setTimeout(r, 50));
    const endMs = Date.now();
    executeCycleOverlap.push({ project: p.id, startMs, endMs });
    const started_at = new Date(startMs).toISOString();
    const ended_at = new Date(endMs).toISOString();
    return {
      cycle_id: `cycle-${p.id}-${executeCycleCalls}`,
      project_id: p.id,
      started_at,
      ended_at,
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
    pickNextProjectCalls++;
    return null;
  },
  pickNextProjects: async (
    _projects: ProjectConfig[],
    _config: unknown,
    _fleet: unknown,
    skipProjectIds: Set<string> = new Set(),
    _max: number = 1,
  ) => {
    pickNextProjectsCalls++;
    const out: Array<{ project: ProjectConfig; reason: string }> = [];
    if (!skipProjectIds.has(projectA.id)) {
      out.push({ project: projectA, reason: "test pick a" });
    }
    if (!skipProjectIds.has(projectB.id)) {
      out.push({ project: projectB, reason: "test pick b" });
    }
    return out;
  },
  shouldChain: async () => ({ chain: false, reason: "parallel mode — no chain" }),
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
  botWorktreePath: (p: { path: string }) => join(p.path, ".bot-worktree"),
}));

mock.module("../../src/audit", () => ({
  appendProgress: async (
    projectId: string,
    event: string,
    data: Record<string, unknown>,
  ) => {
    if (projectId === "_fleet" && event === "session_complete") {
      sessionCompleteEvent = data;
    }
  },
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
}));

mock.module("../../src/work_detection", () => ({
  countRemainingWork: async () => 0,
}));

const { runSession } = await import("../../src/session");

async function run() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

  const results = await runSession({ budgetMinutes: 10, dryRun: true });

  // Compute whether the two cycles overlapped in wall clock. Parallel
  // execution should show [startA, endA] and [startB, endB] with
  // startB < endA (B begins before A finishes).
  let overlap = false;
  if (executeCycleOverlap.length === 2) {
    const [x, y] = executeCycleOverlap;
    overlap =
      (y.startMs < x.endMs && x.startMs < y.endMs) ||
      (x.startMs < y.endMs && y.startMs < x.endMs);
  }

  const output = {
    executeCycleCalls,
    pickNextProjectsCalls,
    pickNextProjectCalls,
    resultCount: results.length,
    projectsCycled: [...new Set(results.map((r) => r.project_id))].sort(),
    overlap,
    sessionComplete: sessionCompleteEvent,
    overlapWindows: executeCycleOverlap.map((w) => ({
      project: w.project,
      duration: w.endMs - w.startMs,
    })),
  };
  console.log(JSON.stringify(output));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
