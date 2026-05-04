// Subprocess driver for tests/integration/usage_budget.test.ts (gs-301d).
// argv[2]: "6" — two-project skip-project session (mocked runSession graph).
// argv[2]: "7" — loadProjectsYaml rejects per-project cap > fleet (real parser).

import { mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { ProjectConfig, CycleResult } from "../../../src/types";
import type { ConsumptionReader, ConsumptionSnapshot } from "../../../src/usage/types";
import { makeProjectConfig, makeDispatcherConfig } from "../../helpers/fixtures";

const scenario = process.argv[2] ?? "";

const FIXTURE_SCENARIO7 = join(
  import.meta.dir,
  "..",
  "..",
  "usage",
  "fixtures",
  "gs301d-scenario7.projects.yaml",
);

if (scenario === "7") {
  const { loadProjectsYaml, ProjectValidationError } = await import(
    "../../../src/projects"
  );

  const errors: string[] = [];
  try {
    await loadProjectsYaml(FIXTURE_SCENARIO7);
    errors.push("expected loadProjectsYaml to throw");
  } catch (e) {
    if (!(e instanceof ProjectValidationError)) {
      errors.push(
        `expected ProjectValidationError, got ${e instanceof Error ? e.name : typeof e}`,
      );
    } else {
      if (e.projectId !== "proj-over") {
        errors.push(`projectId want proj-over, got ${e.projectId}`);
      }
      if (!e.field.includes("session_budget.max_usd")) {
        errors.push(`field should name session_budget.max_usd, got ${e.field}`);
      }
      const msg = e.message;
      if (!msg.includes("exceeds fleet-wide value 5")) {
        errors.push(`message should cite fleet cap, got: ${msg}`);
      }
      if (!msg.includes("per-project budgets must fit within the fleet cap")) {
        errors.push("message should include fleet-cap explanation");
      }
    }
  }

  const output = { pass: errors.length === 0, scenario: "7", errors };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(errors.length > 0 ? 1 : 0);
}

// --- scenario 6 (mocked session) ---

const WORK = join(
  import.meta.dir,
  "..",
  "..",
  "usage",
  "fixtures",
  "gs301d_workspace",
);

let executeCycleCalls = 0;
const cycledProjectIds: string[] = [];

const projA = makeProjectConfig({
  id: "proj-a",
  path: WORK,
  priority: 2,
  verification_command: "bun test",
  cycle_budget_minutes: 1,
  session_budget: {
    max_usd: 3,
    on_exhausted: "skip-project",
    provider_source: "claude_code",
  },
});

const projB = makeProjectConfig({
  id: "proj-b",
  path: WORK,
  priority: 1,
  verification_command: "bun test",
  cycle_budget_minutes: 1,
  session_budget: {
    max_usd: 4,
    on_exhausted: "skip-project",
    provider_source: "claude_code",
  },
});

const dispatcher = makeDispatcherConfig({
  state_dir: join(WORK, "state"),
  max_cycles_per_project_per_session: 100,
  session_budget: {
    max_usd: 10,
    enforcement: "hard",
    provider_source: "claude_code",
  },
});

class FixedUsdReader implements ConsumptionReader {
  readonly name = "synthetic_fleet_usd";

  async readCurrentWindow(): Promise<ConsumptionSnapshot | null> {
    const t = new Date("2026-04-21T14:00:00Z");
    return {
      total_usd: 3.5,
      total_tokens: 0,
      cycles_used: 0,
      source: this.name,
      last_updated: new Date(),
      window_start: t,
    };
  }
}

mock.module("../../../src/usage/factory", () => ({
  createConsumptionReader: () => new FixedUsdReader(),
}));

mock.module("../../../src/projects", () => ({
  loadProjectsYaml: async () => ({
    projects: [projA, projB],
    dispatcher,
  }),
}));

mock.module("../../../src/cycle", () => ({
  countCommitsAhead: async () => 0,
  executeCycle: async (p: ProjectConfig): Promise<CycleResult> => {
    executeCycleCalls++;
    cycledProjectIds.push(p.id);
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
  pickNextProject: async (
    _projects: ProjectConfig[],
    _config: unknown,
    _fleet: unknown,
    skipProjectIds: Set<string>,
  ) => {
    if (!skipProjectIds.has("proj-a")) {
      return { project: projA, reason: "test pick proj-a" };
    }
    if (!skipProjectIds.has("proj-b")) {
      return { project: projB, reason: "test pick proj-b" };
    }
    return null;
  },
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

async function main6() {
  const errors: string[] = [];
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    if (scenario !== "6") {
      errors.push(`unknown scenario "${scenario}" (use 6 or 7)`);
      process.stdout.write(JSON.stringify({ pass: false, errors }) + "\n");
      process.exit(1);
    }

    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(join(WORK, "digests"), { recursive: true });

    const results = await runSession({
      budgetMinutes: 60,
      dryRun: true,
      maxCycles: 2,
    });

    console.warn = origWarn;

    const skipped = capturedEvents.filter(
      (e) => e.event === "session_budget_project_skipped",
    );
    const exceeded = capturedEvents.filter((e) => e.event === "session_budget_exceeded");
    const complete = capturedEvents.find((e) => e.event === "session_complete");

    if (skipped.length !== 1) {
      errors.push(`expected 1 session_budget_project_skipped, got ${skipped.length}`);
    } else if (skipped[0].projectId !== "proj-a") {
      errors.push(`skip event should be on proj-a, got ${skipped[0].projectId}`);
    }

    if (exceeded.length !== 0) {
      errors.push(`expected 0 fleet session_budget_exceeded, got ${exceeded.length}`);
    }

    if (executeCycleCalls !== 2) {
      errors.push(`expected 2 cycles (both on proj-b), got ${executeCycleCalls}`);
    }
    if (cycledProjectIds.some((id) => id !== "proj-b")) {
      errors.push(`all cycles should be proj-b, got ${JSON.stringify(cycledProjectIds)}`);
    }
    if (results.length !== 2 || results.some((r) => r.project_id !== "proj-b")) {
      errors.push("expected two verified results on proj-b only");
    }

    if (complete?.data.stop_reason !== "max-cycles") {
      errors.push(
        `stop_reason want max-cycles, got ${String(complete?.data.stop_reason)}`,
      );
    }

    const output = {
      pass: errors.length === 0,
      scenario: "6",
      execute_cycle_calls: executeCycleCalls,
      skipped_count: skipped.length,
      exceeded_fleet_count: exceeded.length,
      stop_reason: complete?.data.stop_reason ?? null,
      errors,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.warn = origWarn;
    console.error("usage_budget_gs301d_subprocess crashed:", err);
    process.exit(1);
  } finally {
    rmSync(WORK, { recursive: true, force: true });
  }
}

void main6();
