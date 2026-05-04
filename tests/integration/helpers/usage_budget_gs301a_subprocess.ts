// Subprocess driver for tests/integration/usage_budget.test.ts (gs-301a).
// One Bun process per scenario so mock.module graphs stay isolated.
//
// argv[2]: "1" | "9" | "10" — see tests/usage/fixtures/gs301a-scenario*.projects.yaml

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../../src/types";
import { makeProjectConfig, makeDispatcherConfig } from "../../helpers/fixtures";
import { ClaudeCodeReader } from "../../../src/usage/claude_code";

const scenario = process.argv[2] ?? "";
const WORK = join(
  import.meta.dir,
  "..",
  "..",
  "usage",
  "fixtures",
  "gs301a_workspace",
);

let executeCycleCalls = 0;

const project = makeProjectConfig({
  id: "ubudget-proj",
  path: WORK,
  verification_command: "bun test",
  cycle_budget_minutes: 1,
});

function dispatcherFor(s: string) {
  const base = makeDispatcherConfig({
    state_dir: join(WORK, "state"),
    max_cycles_per_project_per_session: 100,
  });
  if (s === "9") {
    return {
      ...base,
      session_budget: {
        max_usd: 1000,
        provider_source: "openrouter" as const,
      },
    };
  }
  if (s === "10") {
    return {
      ...base,
      session_budget: {
        max_usd: 1000,
        provider_source: "claude_code" as const,
      },
    };
  }
  return base;
}

if (scenario === "10") {
  mock.module("../../../src/usage/factory", () => ({
    createConsumptionReader: () =>
      new ClaudeCodeReader(async () => {
        throw new Error("ENOENT: simulated missing Claude Code JSONL");
      }),
  }));
}

mock.module("../../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [project],
    dispatcher: dispatcherFor(scenario),
  }),
}));

mock.module("../../../src/cycle", () => ({
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

mock.module("../../../src/dispatcher", () => ({
  pickNextProject: async () => ({ project, reason: "test pick" }),
  pickNextProjects: async () => [],
  shouldChain: async () => ({ chain: true, reason: "more work" }),
  estimateSessionPlan: () => ({
    picks: [],
    per_project: [],
    total_cycles: 0,
    budget_used_minutes: 0,
    budget_remaining_minutes: 0,
  }),
}));

mock.module("../../../src/safety", () => ({
  isStopFilePresent: async () => false,
}));

mock.module("../../../src/state", () => ({
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
  getRootDir: () => WORK,
  botWorktreePath: (proj: { path: string }) => join(proj.path, ".bot-worktree"),
}));

interface CapturedEvent {
  projectId: string;
  event: string;
  data: Record<string, unknown>;
}

const capturedEvents: CapturedEvent[] = [];

mock.module("../../../src/audit", () => ({
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

mock.module("../../../src/work_detection", () => ({
  countRemainingWork: async () => 0,
}));

mock.module("../../../src/notify", () => ({
  notifySessionEnd: async () => {},
}));

const { runSession } = await import("../../../src/session");

async function main() {
  const errors: string[] = [];
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    warns.push(parts.join(" "));
    origWarn.apply(console, parts);
  };

  try {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(join(WORK, "digests"), { recursive: true });

    const results = await runSession({
      budgetMinutes: 60,
      dryRun: true,
      maxCycles: 2,
    });

    console.warn = origWarn;

    const unavailable = capturedEvents.filter(
      (e) => e.event === "session_budget_reader_unavailable",
    );
    const complete = capturedEvents.find((e) => e.event === "session_complete");

    if (results.length !== 2) {
      errors.push(`expected 2 cycle results, got ${results.length}`);
    }
    if (executeCycleCalls !== 2) {
      errors.push(`expected 2 executeCycle calls, got ${executeCycleCalls}`);
    }
    if (!complete) {
      errors.push("missing session_complete event");
    } else if (complete.data.stop_reason === "usage-budget") {
      errors.push("stop_reason must not be usage-budget (fail-open / no gate)");
    }
    if (complete && complete.data.stop_reason !== "max-cycles") {
      errors.push(
        `expected stop_reason max-cycles, got ${String(complete.data.stop_reason)}`,
      );
    }

    if (scenario === "1") {
      if (unavailable.length !== 0) {
        errors.push(
          `scenario 1: expected no reader-unavailable events, got ${unavailable.length}`,
        );
      }
      const w = warns.join("\n");
      if (w.includes("usage-budget") && w.includes("fail-open")) {
        errors.push("scenario 1: unexpected usage-budget fail-open warning");
      }
    } else if (scenario === "9") {
      if (unavailable.length !== 1) {
        errors.push(
          `scenario 9: expected 1 session_budget_reader_unavailable, got ${unavailable.length}`,
        );
      } else if (unavailable[0].data.reader !== "none") {
        errors.push(
          `scenario 9: expected reader "none", got ${JSON.stringify(unavailable[0].data.reader)}`,
        );
      }
      const w = warns.join("\n");
      if (!w.includes("consumption reader \"none\" unavailable")) {
        errors.push("scenario 9: missing expected fail-open warning text");
      }
      if (!w.includes("fail-open")) {
        errors.push("scenario 9: warning should mention fail-open");
      }
    } else if (scenario === "10") {
      if (unavailable.length !== 1) {
        errors.push(
          `scenario 10: expected 1 session_budget_reader_unavailable, got ${unavailable.length}`,
        );
      } else if (unavailable[0].data.reader !== "claude_code") {
        errors.push(
          `scenario 10: expected reader claude_code, got ${JSON.stringify(unavailable[0].data.reader)}`,
        );
      }
      const w = warns.join("\n");
      if (!w.includes("consumption reader \"claude_code\" unavailable")) {
        errors.push("scenario 10: missing expected fail-open warning text");
      }
    } else {
      errors.push(`unknown scenario "${scenario}" (use 1, 9, or 10)`);
    }

    const output = {
      pass: errors.length === 0,
      scenario,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      unavailable_count: unavailable.length,
      stop_reason: complete?.data.stop_reason ?? null,
      errors,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.warn = origWarn;
    console.error("usage_budget_gs301a_subprocess crashed:", err);
    process.exit(1);
  } finally {
    rmSync(WORK, { recursive: true, force: true });
  }
}

void main();
