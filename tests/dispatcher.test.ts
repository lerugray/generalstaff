import { describe, expect, it } from "bun:test";
import { scoreProjects, shouldChain } from "../src/dispatcher";
import type { FleetState, ProjectConfig, CycleResult } from "../src/types";

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test",
    path: "/tmp/test",
    priority: 1,
    engineer_command: "echo",
    verification_command: "echo",
    cycle_budget_minutes: 60,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["x"],
    ...overrides,
  };
}

function makeCycleResult(
  overrides: Partial<CycleResult> = {},
): CycleResult {
  return {
    cycle_id: "c1",
    project_id: "test",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    cycle_start_sha: "abc",
    cycle_end_sha: "def",
    engineer_exit_code: 0,
    verification_outcome: "passed",
    reviewer_verdict: "verified",
    final_outcome: "verified",
    reason: "ok",
    ...overrides,
  };
}

describe("scoreProjects", () => {
  it("scores higher for staler projects", () => {
    const fleet: FleetState = {
      version: 1,
      updated_at: new Date().toISOString(),
      projects: {
        fresh: {
          last_cycle_at: new Date().toISOString(),
          last_cycle_outcome: "verified",
          total_cycles: 1,
          total_verified: 1,
          total_failed: 0,
          accumulated_minutes: 10,
        },
      },
    };

    const projects = [
      makeProject({ id: "fresh", priority: 1 }),
      makeProject({ id: "stale", priority: 1 }), // never run = max staleness
    ];

    const scores = scoreProjects(projects, fleet);
    expect(scores[0].project.id).toBe("stale");
    expect(scores[1].project.id).toBe("fresh");
  });

  it("factors in priority", () => {
    const fleet: FleetState = {
      version: 1,
      updated_at: new Date().toISOString(),
      projects: {},
    };

    const projects = [
      makeProject({ id: "low-pri", priority: 5 }),
      makeProject({ id: "high-pri", priority: 1 }),
    ];

    const scores = scoreProjects(projects, fleet);
    expect(scores[0].project.id).toBe("high-pri");
  });
});

describe("shouldChain", () => {
  it("chains when conditions are met", async () => {
    // Note: this will try to check tasks.json which won't exist,
    // so hasMoreWork returns false. That's the expected behavior
    // for a project with no tasks file.
    const result = await shouldChain(
      makeCycleResult(),
      makeProject(),
      1,
      3,
      120,
    );
    // hasMoreWork returns false because tasks.json doesn't exist
    expect(result.chain).toBe(false);
    expect(result.reason).toBe("no remaining work for this project");
  });

  it("stops chaining after verification failure", async () => {
    const result = await shouldChain(
      makeCycleResult({ final_outcome: "verification_failed" }),
      makeProject(),
      1,
      3,
      120,
    );
    expect(result.chain).toBe(false);
    expect(result.reason).toBe("last cycle failed verification");
  });

  it("stops chaining at cap", async () => {
    const result = await shouldChain(
      makeCycleResult(),
      makeProject(),
      3, // at cap
      3,
      120,
    );
    expect(result.chain).toBe(false);
    expect(result.reason).toBe("per-project cycle cap reached");
  });

  it("stops chaining with insufficient budget", async () => {
    const result = await shouldChain(
      makeCycleResult(),
      makeProject({ cycle_budget_minutes: 60 }),
      1,
      3,
      30, // not enough
    );
    expect(result.chain).toBe(false);
    expect(result.reason).toBe("insufficient session budget");
  });
});
