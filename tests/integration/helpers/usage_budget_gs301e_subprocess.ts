// Subprocess driver for tests/integration/usage_budget.test.ts (gs-301e).
// argv[2]: "8" — loadProjectsYaml rejects fleet session_budget with two units (real parser).
// argv[2]: "11" — load valid fixture + ClaudeCodeReader (injected blocks) × evaluateUsageBudget:
//   three timestamp/window shapes proving active 5h-block totals (not cross-block sum,
//   not session clock).

import { join } from "path";
import {
  ClaudeCodeReader,
  type SessionBlockLike,
  type SessionBlockLoader,
} from "../../../src/usage/claude_code";
import { evaluateUsageBudget } from "../../../src/usage/budget_gate";

const scenario = process.argv[2] ?? "";

const FIXTURE_SCENARIO8 = join(
  import.meta.dir,
  "..",
  "..",
  "usage",
  "fixtures",
  "gs301e-scenario8.projects.yaml",
);

const FIXTURE_SCENARIO11 = join(
  import.meta.dir,
  "..",
  "..",
  "usage",
  "fixtures",
  "gs301e-scenario11.projects.yaml",
);

function block(overrides: Partial<SessionBlockLike> = {}): SessionBlockLike {
  return {
    startTime: overrides.startTime ?? new Date("2026-05-04T12:00:00.000Z"),
    endTime: overrides.endTime ?? new Date("2026-05-04T17:00:00.000Z"),
    actualEndTime: overrides.actualEndTime,
    isGap: overrides.isGap,
    costUSD: overrides.costUSD ?? 0,
    tokenCounts: overrides.tokenCounts ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    entries: overrides.entries ?? [],
  };
}

function loaderOf(blocks: SessionBlockLike[]): SessionBlockLoader {
  return async () => blocks;
}

if (scenario === "8") {
  const { loadProjectsYaml, ProjectValidationError } = await import(
    "../../../src/projects"
  );

  const errors: string[] = [];
  try {
    await loadProjectsYaml(FIXTURE_SCENARIO8);
    errors.push("expected loadProjectsYaml to throw");
  } catch (e) {
    if (!(e instanceof ProjectValidationError)) {
      errors.push(
        `expected ProjectValidationError, got ${e instanceof Error ? e.name : typeof e}`,
      );
    } else {
      if (e.projectId !== "dispatcher") {
        errors.push(`projectId want dispatcher, got ${e.projectId}`);
      }
      if (e.field !== "session_budget") {
        errors.push(`field want session_budget, got ${e.field}`);
      }
      const msg = e.message;
      if (!msg.includes("max_usd")) {
        errors.push(`message should name max_usd, got: ${msg}`);
      }
      if (!msg.includes("max_tokens")) {
        errors.push(`message should name max_tokens, got: ${msg}`);
      }
      if (!msg.includes("exactly one")) {
        errors.push(`message should cite exactly-one rule, got: ${msg}`);
      }
    }
  }

  const output = { pass: errors.length === 0, scenario: "8", errors };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(errors.length > 0 ? 1 : 0);
}

if (scenario === "11") {
  const { loadProjectsYaml } = await import("../../../src/projects");

  const errors: string[] = [];

  let project;
  let dispatcher;
  try {
    const loaded = await loadProjectsYaml(FIXTURE_SCENARIO11);
    project = loaded.projects[0];
    dispatcher = loaded.dispatcher;
  } catch (e) {
    errors.push(
      `loadProjectsYaml failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    const output = { pass: false, scenario: "11", cases_passed: 0, errors };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(1);
  }

  if (dispatcher.session_budget?.max_usd !== 5) {
    errors.push("fixture fleet max_usd should be 5");
  }

  // Case A — fresh active block: zero spend at window start → budget ok, window_start = block start.
  {
    const t0 = new Date("2026-05-04T12:00:00.000Z");
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          startTime: t0,
          endTime: new Date("2026-05-04T17:00:00.000Z"),
          actualEndTime: new Date("2026-05-04T12:01:00.000Z"),
          costUSD: 0,
          entries: [],
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    if (!snap) {
      errors.push("case A: expected snapshot");
    } else {
      if (snap.total_usd !== 0) {
        errors.push(`case A: fresh window want total_usd 0, got ${snap.total_usd}`);
      }
      if (snap.window_start.toISOString() !== t0.toISOString()) {
        errors.push(
          `case A: window_start want ${t0.toISOString()}, got ${snap.window_start.toISOString()}`,
        );
      }
    }
    const outcome = await evaluateUsageBudget(reader, project, dispatcher);
    if (outcome.kind !== "ok") {
      errors.push(`case A: evaluateUsageBudget want ok, got ${outcome.kind}`);
    }
  }

  // Case B — mid-window: block started hours ago with spend above fleet cap → hit uses block total, not zero.
  {
    const t0 = new Date("2026-05-04T08:00:00.000Z");
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          startTime: t0,
          endTime: new Date("2026-05-04T13:00:00.000Z"),
          actualEndTime: new Date("2026-05-04T11:30:00.000Z"),
          costUSD: 6,
          entries: [{}, {}],
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    if (!snap) {
      errors.push("case B: expected snapshot");
    } else {
      if (snap.total_usd !== 6) {
        errors.push(`case B: want total_usd 6 (mid-window accrual), got ${snap.total_usd}`);
      }
      if (snap.window_start.toISOString() !== t0.toISOString()) {
        errors.push("case B: window_start should be block start, not session clock");
      }
    }
    const outcome = await evaluateUsageBudget(reader, project, dispatcher);
    if (outcome.kind !== "hit") {
      errors.push(`case B: want hit over cap, got ${outcome.kind}`);
    } else {
      if (outcome.unit !== "max_usd") {
        errors.push(`case B: unit want max_usd, got ${outcome.unit}`);
      }
      if (outcome.consumed !== 6 || outcome.budget !== 5) {
        errors.push(
          `case B: want consumed 6 budget 5, got consumed=${outcome.consumed} budget=${outcome.budget}`,
        );
      }
    }
  }

  // Case C — rolled window: older block had heavy spend; new active block is small → only latest block counts.
  {
    const reader = new ClaudeCodeReader(
      loaderOf([
        block({
          startTime: new Date("2026-05-04T06:00:00.000Z"),
          endTime: new Date("2026-05-04T11:00:00.000Z"),
          costUSD: 100,
          entries: Array.from({ length: 50 }, () => ({})),
        }),
        block({
          startTime: new Date("2026-05-04T12:00:00.000Z"),
          endTime: new Date("2026-05-04T17:00:00.000Z"),
          costUSD: 0.5,
          entries: [{}],
        }),
      ]),
    );
    const snap = await reader.readCurrentWindow();
    if (!snap) {
      errors.push("case C: expected snapshot");
    } else {
      if (snap.total_usd !== 0.5) {
        errors.push(
          `case C: must not sum prior block — want 0.5, got ${snap.total_usd}`,
        );
      }
      if (snap.window_start.toISOString() !== "2026-05-04T12:00:00.000Z") {
        errors.push(
          `case C: window_start should be new block start, got ${snap.window_start.toISOString()}`,
        );
      }
      if (snap.cycles_used !== 1) {
        errors.push(`case C: cycles_used should be latest block only, got ${snap.cycles_used}`);
      }
    }
    const outcome = await evaluateUsageBudget(reader, project, dispatcher);
    if (outcome.kind !== "ok") {
      errors.push(
        `case C: should not false-positive hit fleet cap (wrong sum would hit), got ${outcome.kind}`,
      );
    }
  }

  const output = {
    pass: errors.length === 0,
    scenario: "11",
    cases_passed: errors.length === 0 ? 3 : 0,
    errors,
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(errors.length > 0 ? 1 : 0);
}

process.stdout.write(
  JSON.stringify({
    pass: false,
    errors: [`unknown scenario "${scenario}" (use 8 or 11)`],
  }) + "\n",
);
process.exit(1);
