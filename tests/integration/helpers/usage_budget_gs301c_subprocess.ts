// Subprocess driver for tests/integration/usage_budget.test.ts (gs-301c).
// argv[2]: "4" | "5" — see tests/usage/fixtures/gs301c-scenario*.projects.yaml

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../../src/types";
import type { ConsumptionReader, ConsumptionSnapshot } from "../../../src/usage/types";
import { makeProjectConfig, makeDispatcherConfig } from "../../helpers/fixtures";

const scenario = process.argv[2] ?? "";
const WORK = join(
  import.meta.dir,
  "..",
  "..",
  "usage",
  "fixtures",
  "gs301c_workspace",
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
  if (s === "4") {
    return {
      ...base,
      session_budget: {
        max_tokens: 1000,
        enforcement: "hard" as const,
        provider_source: "claude_code" as const,
      },
    };
  }
  if (s === "5") {
    return {
      ...base,
      session_budget: {
        max_cycles: 2,
        enforcement: "hard" as const,
        provider_source: "claude_code" as const,
      },
    };
  }
  return base;
}

/** First read under token cap; later reads over max_tokens (scenario 4). */
class SteppingTokensReader implements ConsumptionReader {
  readonly name = "synthetic_stepping_tokens";
  private callCount = 0;

  async readCurrentWindow(): Promise<ConsumptionSnapshot | null> {
    this.callCount++;
    const t = new Date("2026-04-21T14:00:00Z");
    const base = {
      total_usd: 0,
      cycles_used: 0,
      source: this.name,
      last_updated: new Date(),
      window_start: t,
    };
    if (this.callCount === 1) {
      return { ...base, total_tokens: 500 };
    }
    return { ...base, total_tokens: 50_000 };
  }
}

/**
 * cycles_used 0 → 1 → 2 across reads so two cycles complete then the gate
 * fires before a third (fleet max_cycles: 2, >= semantics).
 */
class SteppingCyclesReader implements ConsumptionReader {
  readonly name = "synthetic_stepping_cycles";
  private callCount = 0;

  async readCurrentWindow(): Promise<ConsumptionSnapshot | null> {
    this.callCount++;
    const t = new Date("2026-04-21T14:00:00Z");
    const used = this.callCount - 1;
    return {
      total_usd: 0,
      total_tokens: 0,
      cycles_used: used,
      source: this.name,
      last_updated: new Date(),
      window_start: t,
    };
  }
}

mock.module("../../../src/usage/factory", () => ({
  createConsumptionReader: () =>
    scenario === "5" ? new SteppingCyclesReader() : new SteppingTokensReader(),
}));

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
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(join(WORK, "digests"), { recursive: true });

    const results = await runSession({
      budgetMinutes: 60,
      dryRun: true,
      maxCycles: 20,
    });

    console.warn = origWarn;

    const exceeded = capturedEvents.filter((e) => e.event === "session_budget_exceeded");
    const complete = capturedEvents.find((e) => e.event === "session_complete");

    if (scenario === "4") {
      if (executeCycleCalls !== 1) {
        errors.push(`scenario 4: expected 1 cycle, got ${executeCycleCalls}`);
      }
      if (results.length !== 1) {
        errors.push(`scenario 4: expected 1 result, got ${results.length}`);
      }
      if (complete?.data.stop_reason !== "usage-budget") {
        errors.push(
          `scenario 4: stop_reason expected usage-budget, got ${String(complete?.data.stop_reason)}`,
        );
      }
      if (exceeded.length !== 1) {
        errors.push(`scenario 4: expected 1 session_budget_exceeded, got ${exceeded.length}`);
      } else {
        const d = exceeded[0].data;
        if (d.unit !== "max_tokens") {
          errors.push(`scenario 4: unit want max_tokens, got ${String(d.unit)}`);
        }
        if (typeof d.consumed !== "number" || (d.consumed as number) < 1000) {
          errors.push(`scenario 4: consumed should be >= 1000, got ${String(d.consumed)}`);
        }
      }
      const sum = complete?.data.consumption_summary as Record<string, unknown> | undefined;
      if (!sum || typeof sum.total_tokens !== "number") {
        errors.push("scenario 4: session_complete should carry consumption_summary.total_tokens");
      } else if ((sum.total_tokens as number) < 1000) {
        errors.push("scenario 4: consumption_summary tokens should reflect exceeded window");
      }
    } else if (scenario === "5") {
      if (executeCycleCalls !== 2) {
        errors.push(`scenario 5: expected 2 cycles before gate, got ${executeCycleCalls}`);
      }
      if (results.length !== 2) {
        errors.push(`scenario 5: expected 2 results, got ${results.length}`);
      }
      if (complete?.data.stop_reason !== "usage-budget") {
        errors.push(
          `scenario 5: stop_reason expected usage-budget, got ${String(complete?.data.stop_reason)}`,
        );
      }
      if (exceeded.length !== 1) {
        errors.push(`scenario 5: expected 1 session_budget_exceeded, got ${exceeded.length}`);
      } else {
        const d = exceeded[0].data;
        if (d.unit !== "max_cycles") {
          errors.push(`scenario 5: unit want max_cycles, got ${String(d.unit)}`);
        }
        if (d.budget !== 2) {
          errors.push(`scenario 5: budget want 2, got ${String(d.budget)}`);
        }
        if (typeof d.consumed !== "number" || (d.consumed as number) < 2) {
          errors.push(`scenario 5: consumed should be >= 2, got ${String(d.consumed)}`);
        }
      }
    } else {
      errors.push(`unknown scenario "${scenario}" (use 4 or 5)`);
    }

    const output = {
      pass: errors.length === 0,
      scenario,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      stop_reason: complete?.data.stop_reason ?? null,
      exceeded_count: exceeded.length,
      errors,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.warn = origWarn;
    console.error("usage_budget_gs301c_subprocess crashed:", err);
    process.exit(1);
  } finally {
    rmSync(WORK, { recursive: true, force: true });
  }
}

void main();
