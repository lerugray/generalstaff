// Isolated test helper: proves runSession emits exactly one
// "session_complete" fleet-level ProgressEntry at session end, and that
// the entry carries the aggregated stats (duration, totals, stop_reason).

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "./fixtures";

const TEST_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  "session_complete_event_test",
);

let pickCalls = 0;
let executeCycleCalls = 0;

const project = makeProjectConfig({
  path: TEST_DIR,
  verification_command: "bun test",
  cycle_budget_minutes: 1,
});

mock.module("../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [project],
    dispatcher: makeDispatcherConfig({
      state_dir: join(TEST_DIR, "state"),
      max_cycles_per_project_per_session: 100,
    }),
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
  pickNextProject: async () => {
    pickCalls++;
    if (pickCalls <= 2) return { project, reason: "test pick" };
    return null;
  },
  pickNextProjects: async () => [],
  shouldChain: async () => ({ chain: false, reason: "stop after one" }),
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

interface CapturedEvent {
  projectId: string;
  event: string;
  data: Record<string, unknown>;
}

const capturedEvents: CapturedEvent[] = [];

mock.module("../../src/audit", () => ({
  appendProgress: async (
    projectId: string,
    event: string,
    data: Record<string, unknown>,
  ) => {
    capturedEvents.push({ projectId, event, data });
  },
  loadProgressEvents: async () => [],
  setVerboseMode: () => {},
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
  console.log = () => {};

  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "digests"), { recursive: true });

    await runSession({ budgetMinutes: 60, dryRun: true });

    console.log = origLog;

    const completeEvents = capturedEvents.filter(
      (e) => e.event === "session_complete",
    );
    const sessionEndEvents = capturedEvents.filter(
      (e) => e.event === "session_end",
    );

    const errors: string[] = [];
    if (completeEvents.length !== 1) {
      errors.push(
        `expected exactly 1 session_complete event, got ${completeEvents.length}`,
      );
    }

    const ev = completeEvents[0];
    if (ev) {
      if (ev.projectId !== "_fleet") {
        errors.push(
          `expected projectId "_fleet", got "${ev.projectId}"`,
        );
      }
      const expectKeys = [
        "duration_minutes",
        "total_cycles",
        "total_verified",
        "total_failed",
        "stop_reason",
      ];
      for (const k of expectKeys) {
        if (!(k in ev.data)) {
          errors.push(`session_complete.data missing key "${k}"`);
        }
      }
      if (ev.data.total_cycles !== executeCycleCalls) {
        errors.push(
          `total_cycles mismatch: event=${ev.data.total_cycles} actual=${executeCycleCalls}`,
        );
      }
      if (ev.data.total_verified !== executeCycleCalls) {
        errors.push(
          `total_verified mismatch: event=${ev.data.total_verified} expected=${executeCycleCalls}`,
        );
      }
      if (ev.data.total_failed !== 0) {
        errors.push(`total_failed should be 0, got ${ev.data.total_failed}`);
      }
    }

    // Per-project session_end events must also carry stop_reason so
    // retrospective analyses can slice by project without joining
    // against _fleet/session_complete.
    const fleetStopReason = ev?.data.stop_reason as string | undefined;
    for (const se of sessionEndEvents) {
      if (se.projectId === "_fleet") {
        errors.push(
          `session_end should be per-project, not _fleet (got "${se.projectId}")`,
        );
        continue;
      }
      if (!("stop_reason" in se.data)) {
        errors.push(
          `session_end for ${se.projectId} missing stop_reason`,
        );
        continue;
      }
      if (se.data.stop_reason !== fleetStopReason) {
        errors.push(
          `session_end for ${se.projectId} stop_reason mismatch: ` +
            `got "${se.data.stop_reason}", fleet says "${fleetStopReason}"`,
        );
      }
    }

    const output = {
      pass: errors.length === 0,
      complete_event_count: completeEvents.length,
      session_end_event_count: sessionEndEvents.length,
      execute_cycle_calls: executeCycleCalls,
      fleet_project_id: ev?.projectId ?? null,
      event_data: ev?.data ?? null,
      errors,
    };
    console.log(JSON.stringify(output));
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
