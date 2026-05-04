// Subprocess driver for tests/integration/usage_budget.test.ts (gs-301b).
// argv[2]: "2" | "3" — see tests/usage/fixtures/gs301b-scenario*.projects.yaml

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
  "gs301b_workspace",
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
  if (s === "2") {
    return {
      ...base,
      session_budget: {
        max_usd: 5,
        enforcement: "hard" as const,
        provider_source: "claude_code" as const,
      },
    };
  }
  if (s === "3") {
    return {
      ...base,
      session_budget: {
        max_usd: 5,
        enforcement: "advisory" as const,
        provider_source: "claude_code" as const,
      },
    };
  }
  return base;
}

/** First read under cap; every subsequent read over cap (mid-session hit). */
class SteppingUsdReader implements ConsumptionReader {
  readonly name = "synthetic_stepping_usd";
  private callCount = 0;

  async readCurrentWindow(): Promise<ConsumptionSnapshot | null> {
    this.callCount++;
    const t = new Date("2026-04-21T14:00:00Z");
    const base = {
      total_tokens: 0,
      cycles_used: this.callCount,
      source: this.name,
      last_updated: new Date(),
      window_start: t,
    };
    if (this.callCount === 1) {
      return { ...base, total_usd: 1 };
    }
    return { ...base, total_usd: 10 };
  }
}

mock.module("../../../src/usage/factory", () => ({
  createConsumptionReader: () => new SteppingUsdReader(),
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
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    warns.push(parts.join(" "));
    origWarn.apply(console, parts);
  };

  try {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(join(WORK, "digests"), { recursive: true });

    const maxCycles = scenario === "3" ? 3 : 20;
    const results = await runSession({
      budgetMinutes: 60,
      dryRun: true,
      maxCycles,
    });

    console.warn = origWarn;

    const exceeded = capturedEvents.filter((e) => e.event === "session_budget_exceeded");
    const advisory = capturedEvents.filter((e) => e.event === "session_budget_advisory");
    const complete = capturedEvents.find((e) => e.event === "session_complete");

    if (scenario === "2") {
      if (executeCycleCalls !== 1) {
        errors.push(`scenario 2: expected 1 cycle, got ${executeCycleCalls}`);
      }
      if (results.length !== 1) {
        errors.push(`scenario 2: expected 1 result, got ${results.length}`);
      }
      if (complete?.data.stop_reason !== "usage-budget") {
        errors.push(
          `scenario 2: stop_reason expected usage-budget, got ${String(complete?.data.stop_reason)}`,
        );
      }
      if (exceeded.length !== 1) {
        errors.push(
          `scenario 2: expected 1 session_budget_exceeded, got ${exceeded.length}`,
        );
      } else {
        const d = exceeded[0].data;
        if (d.unit !== "max_usd") {
          errors.push(`scenario 2: exceeded event unit want max_usd, got ${String(d.unit)}`);
        }
        if (typeof d.consumed !== "number" || (d.consumed as number) < 5) {
          errors.push(`scenario 2: consumed should be >= 5, got ${String(d.consumed)}`);
        }
      }
      if (advisory.length !== 0) {
        errors.push(`scenario 2: expected 0 advisory events, got ${advisory.length}`);
      }
      const sum = complete?.data.consumption_summary as Record<string, unknown> | undefined;
      if (!sum || typeof sum.total_usd !== "number") {
        errors.push("scenario 2: session_complete should carry consumption_summary.total_usd (gs-299)");
      } else if ((sum.total_usd as number) < 5) {
        errors.push("scenario 2: consumption_summary should reflect exceeded window (>= cap)");
      }
    } else if (scenario === "3") {
      if (executeCycleCalls !== 3) {
        errors.push(`scenario 3: expected 3 cycles, got ${executeCycleCalls}`);
      }
      if (results.length !== 3) {
        errors.push(`scenario 3: expected 3 results, got ${results.length}`);
      }
      if (complete?.data.stop_reason !== "max-cycles") {
        errors.push(
          `scenario 3: stop_reason expected max-cycles, got ${String(complete?.data.stop_reason)}`,
        );
      }
      if (exceeded.length !== 0) {
        errors.push(`scenario 3: expected 0 session_budget_exceeded, got ${exceeded.length}`);
      }
      if (advisory.length < 2) {
        errors.push(
          `scenario 3: expected >=2 session_budget_advisory (pre-cycle 2 and 3), got ${advisory.length}`,
        );
      }
      const advWarns = warns.filter((w) => w.includes("[usage-budget] advisory"));
      if (advWarns.length !== 1) {
        errors.push(
          `scenario 3: expected exactly 1 console advisory warning (warn-once), got ${advWarns.length}`,
        );
      }
      const sum = complete?.data.consumption_summary as Record<string, unknown> | undefined;
      if (!sum || typeof sum.total_usd !== "number") {
        errors.push("scenario 3: session_complete should include consumption_summary");
      } else if ((sum.total_usd as number) < 5) {
        errors.push("scenario 3: final consumption should still show spend above cap (reporting)");
      }
    } else {
      errors.push(`unknown scenario "${scenario}" (use 2 or 3)`);
    }

    const output = {
      pass: errors.length === 0,
      scenario,
      execute_cycle_calls: executeCycleCalls,
      result_count: results.length,
      stop_reason: complete?.data.stop_reason ?? null,
      exceeded_count: exceeded.length,
      advisory_count: advisory.length,
      errors,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.warn = origWarn;
    console.error("usage_budget_gs301b_subprocess crashed:", err);
    process.exit(1);
  } finally {
    rmSync(WORK, { recursive: true, force: true });
  }
}

void main();
