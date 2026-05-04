import { describe, expect, it } from "bun:test";
import {
  evaluateUsageBudget,
  resolveProviderSource,
  decideBudgetAction,
} from "../../src/usage/budget_gate";
import type { BudgetHit } from "../../src/usage/budget_gate";
import type {
  ConsumptionReader,
  ConsumptionSnapshot,
} from "../../src/usage/types";
import type {
  DispatcherConfig,
  ProjectConfig,
  SessionBudget,
} from "../../src/types";

// Minimal dispatcher config for tests — only session_budget varies
// per test; other fields are set to harmless defaults.
function dispatcher(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    state_dir: "./state",
    fleet_state_file: "./fleet_state.json",
    stop_file: "./STOP",
    override_file: "./next_project.txt",
    picker: "priority_x_staleness",
    max_cycles_per_project_per_session: 3,
    log_dir: "./logs",
    digest_dir: "./digests",
    max_parallel_slots: 1,
    max_consecutive_empty: 3,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test",
    path: "/tmp/test",
    priority: 1,
    engineer_command: "echo",
    verification_command: "echo",
    cycle_budget_minutes: 30,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["secret/"],
    ...overrides,
  };
}

function readerReturning(
  snap: ConsumptionSnapshot | null,
): ConsumptionReader {
  return {
    name: "test",
    readCurrentWindow: async () => snap,
  };
}

function snap(overrides: Partial<ConsumptionSnapshot> = {}): ConsumptionSnapshot {
  return {
    total_usd: 0,
    total_tokens: 0,
    cycles_used: 0,
    source: "test",
    last_updated: new Date("2026-04-21T18:00:00Z"),
    window_start: new Date("2026-04-21T14:00:00Z"),
    ...overrides,
  };
}

describe("evaluateUsageBudget (gs-298)", () => {
  it("returns 'ok' with no reader call when no budget is configured", async () => {
    // Pass a reader that would throw if called — proves the hot path
    // short-circuits before touching the reader.
    const reader: ConsumptionReader = {
      name: "boom",
      readCurrentWindow: async () => {
        throw new Error("reader should not have been called");
      },
    };
    const outcome = await evaluateUsageBudget(reader, project(), dispatcher());
    expect(outcome).toEqual({ kind: "ok" });
  });

  it("returns 'unavailable' when a budget is configured but reader is null", async () => {
    const outcome = await evaluateUsageBudget(
      null,
      project(),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    expect(outcome.kind).toBe("unavailable");
  });

  it("returns 'unavailable' when reader returns null snapshot", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(null),
      project(),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    expect(outcome.kind).toBe("unavailable");
  });

  it("returns 'ok' when consumption is under budget", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 2 })),
      project(),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    expect(outcome.kind).toBe("ok");
  });

  it("hits a fleet cap when only fleet budget is set", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 5 })),
      project(),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.scope).toBe("fleet");
    expect(outcome.unit).toBe("max_usd");
    expect(outcome.budget).toBe(5);
    expect(outcome.consumed).toBe(5);
  });

  it("hits a per-project cap when only project budget is set", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_tokens: 100000 })),
      project({ session_budget: { max_tokens: 100000 } }),
      dispatcher(),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.scope).toBe("project");
    expect(outcome.unit).toBe("max_tokens");
  });

  it("treats at-cap consumption as a hit (>=, not >)", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 5.0 })),
      project(),
      dispatcher({ session_budget: { max_usd: 5.0 } }),
    );
    expect(outcome.kind).toBe("hit");
  });

  it("prefers the per-project hit over the fleet hit when both bind", async () => {
    // Both caps trigger on the same snapshot; project check runs first
    // so the outcome names the project scope — enables skip-project
    // action when configured.
    const s = snap({ total_usd: 4 });
    const outcome = await evaluateUsageBudget(
      readerReturning(s),
      project({ session_budget: { max_usd: 2 } }),
      dispatcher({ session_budget: { max_usd: 3 } }),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.scope).toBe("project");
    expect(outcome.budget).toBe(2);
  });

  it("falls through from project-ok to fleet-hit", async () => {
    // Project cap not hit (max_usd=10, consumed=6), fleet cap hit
    // (max_usd=5, consumed=6). Outcome should be fleet-scoped.
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 6 })),
      project({ session_budget: { max_usd: 10 } }),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.scope).toBe("fleet");
  });

  it("defaults enforcement to 'hard' when unset", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 5 })),
      project(),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    if (outcome.kind !== "hit") throw new Error("expected hit");
    expect(outcome.enforcement).toBe("hard");
  });

  it("preserves explicit enforcement='advisory'", async () => {
    const budget: SessionBudget = { max_usd: 5, enforcement: "advisory" };
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 5 })),
      project(),
      dispatcher({ session_budget: budget }),
    );
    if (outcome.kind !== "hit") throw new Error("expected hit");
    expect(outcome.enforcement).toBe("advisory");
  });

  it("defaults on_exhausted to 'break-session' when unset", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 2 })),
      project({ session_budget: { max_usd: 2 } }),
      dispatcher(),
    );
    if (outcome.kind !== "hit") throw new Error("expected hit");
    expect(outcome.on_exhausted).toBe("break-session");
  });

  it("preserves explicit on_exhausted='skip-project'", async () => {
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 2 })),
      project({
        session_budget: { max_usd: 2, on_exhausted: "skip-project" },
      }),
      dispatcher(),
    );
    if (outcome.kind !== "hit") throw new Error("expected hit");
    expect(outcome.on_exhausted).toBe("skip-project");
  });

  it("fleet hits always carry on_exhausted='break-session'", async () => {
    // Fleet caps can't have on_exhausted set (config validation
    // rejects it); any fleet hit should default-report break-session.
    const outcome = await evaluateUsageBudget(
      readerReturning(snap({ total_usd: 5 })),
      project(),
      dispatcher({ session_budget: { max_usd: 5 } }),
    );
    if (outcome.kind !== "hit") throw new Error("expected hit");
    expect(outcome.on_exhausted).toBe("break-session");
  });
});

describe("decideBudgetAction (gs-298) — the four branches", () => {
  // Build a BudgetHit fixture; tests override just the fields that
  // matter for the branch under test.
  function hit(overrides: Partial<BudgetHit> = {}): BudgetHit {
    return {
      kind: "hit",
      scope: "project",
      unit: "max_usd",
      budget: 5,
      consumed: 5,
      source: "test",
      enforcement: "hard",
      on_exhausted: "break-session",
      ...overrides,
    };
  }

  it("'ok' outcome → proceed (cycle runs)", () => {
    expect(decideBudgetAction({ kind: "ok" })).toBe("proceed");
  });

  it("'unavailable' outcome → proceed (fail-open)", () => {
    expect(decideBudgetAction({ kind: "unavailable" })).toBe("proceed");
  });

  it("hit + advisory → proceed (warning, but cycle runs)", () => {
    expect(decideBudgetAction(hit({ enforcement: "advisory" }))).toBe("proceed");
    // Advisory applies regardless of scope
    expect(
      decideBudgetAction(hit({ scope: "fleet", enforcement: "advisory" })),
    ).toBe("proceed");
  });

  it("hit + hard + fleet scope → stop (on_exhausted irrelevant for fleet)", () => {
    expect(decideBudgetAction(hit({ scope: "fleet" }))).toBe("stop");
  });

  it("hit + hard + project + on_exhausted=break-session → stop", () => {
    expect(
      decideBudgetAction(
        hit({ scope: "project", on_exhausted: "break-session" }),
      ),
    ).toBe("stop");
  });

  it("hit + hard + project + on_exhausted=skip-project → skip", () => {
    expect(
      decideBudgetAction(
        hit({ scope: "project", on_exhausted: "skip-project" }),
      ),
    ).toBe("skip");
  });
});

describe("resolveProviderSource (gs-298)", () => {
  it("returns undefined when no budgets are configured", () => {
    expect(resolveProviderSource([project()], dispatcher())).toBeUndefined();
  });

  it("returns fleet's provider_source when set", () => {
    expect(
      resolveProviderSource(
        [project()],
        dispatcher({
          session_budget: { max_usd: 5, provider_source: "openrouter" },
        }),
      ),
    ).toBe("openrouter");
  });

  it("falls through to first project's provider_source when fleet doesn't set one", () => {
    const p = project({
      session_budget: { max_usd: 1, provider_source: "anthropic_api" },
    });
    expect(
      resolveProviderSource(
        [p],
        dispatcher({ session_budget: { max_usd: 5 } }),
      ),
    ).toBe("anthropic_api");
  });

  it("defaults to 'claude_code' when budgets exist but no provider_source is set", () => {
    expect(
      resolveProviderSource(
        [project({ session_budget: { max_cycles: 10 } })],
        dispatcher(),
      ),
    ).toBe("claude_code");
  });

  it("returns a project's provider_source when only project-level budgets are set", () => {
    const p = project({
      session_budget: { max_usd: 2, provider_source: "ollama" },
    });
    expect(resolveProviderSource([p], dispatcher())).toBe("ollama");
  });
});
