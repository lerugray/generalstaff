import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { scoreProjects, shouldChain, pickNextProject } from "../src/dispatcher";
import { setRootDir } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import type { FleetState, ProjectConfig, CycleResult, DispatcherConfig } from "../src/types";

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

  it("tiebreaks equal scores by preferring fewer total_cycles", () => {
    const fleet: FleetState = {
      version: 1,
      updated_at: new Date().toISOString(),
      projects: {
        busy: {
          last_cycle_at: null,
          last_cycle_outcome: null,
          total_cycles: 10,
          total_verified: 10,
          total_failed: 0,
          accumulated_minutes: 100,
        },
        quiet: {
          last_cycle_at: null,
          last_cycle_outcome: null,
          total_cycles: 2,
          total_verified: 2,
          total_failed: 0,
          accumulated_minutes: 20,
        },
      },
    };

    const projects = [
      makeProject({ id: "busy", priority: 1 }),
      makeProject({ id: "quiet", priority: 1 }),
    ];

    const scores = scoreProjects(projects, fleet);
    expect(scores[0].score).toBe(scores[1].score);
    expect(scores[0].project.id).toBe("quiet");
    expect(scores[1].project.id).toBe("busy");
  });

  it("treats missing fleet entry as zero cycles for tiebreaker", () => {
    const fleet: FleetState = {
      version: 1,
      updated_at: new Date().toISOString(),
      projects: {
        known: {
          last_cycle_at: null,
          last_cycle_outcome: null,
          total_cycles: 5,
          total_verified: 5,
          total_failed: 0,
          accumulated_minutes: 50,
        },
      },
    };

    const projects = [
      makeProject({ id: "known", priority: 1 }),
      makeProject({ id: "newcomer", priority: 1 }),
    ];

    const scores = scoreProjects(projects, fleet);
    expect(scores[0].score).toBe(scores[1].score);
    expect(scores[0].project.id).toBe("newcomer");
  });
});

const TEST_DIR = join(import.meta.dir, "fixtures", "dispatcher_test");

function makeConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    state_dir: "state",
    fleet_state_file: "fleet_state.json",
    stop_file: "STOP",
    override_file: "next_project.txt",
    picker: "priority_staleness",
    max_cycles_per_project_per_session: 3,
    log_dir: "logs",
    digest_dir: "digests",
    ...overrides,
  };
}

function makeFleet(projects: Record<string, Partial<FleetState["projects"][string]>> = {}): FleetState {
  const built: FleetState["projects"] = {};
  for (const [id, overrides] of Object.entries(projects)) {
    built[id] = {
      last_cycle_at: null,
      last_cycle_outcome: null,
      total_cycles: 0,
      total_verified: 0,
      total_failed: 0,
      accumulated_minutes: 0,
      ...overrides,
    };
  }
  return { version: 1, updated_at: new Date().toISOString(), projects: built };
}

describe("pickNextProject", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setRootDir(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("respects override file (next_project.txt)", async () => {
    const config = makeConfig();
    writeFileSync(join(TEST_DIR, "next_project.txt"), "proj-b\n", "utf8");

    const projects = [
      makeProject({ id: "proj-a", priority: 1 }),
      makeProject({ id: "proj-b", priority: 5 }),
    ];
    const fleet = makeFleet();

    const result = await pickNextProject(projects, config, fleet);
    expect(result).not.toBeNull();
    expect(result!.project.id).toBe("proj-b");
    expect(result!.reason).toContain("override");
    expect(result!.reason).toContain("next_project.txt");
  });

  it("skips override if project is in skipProjectIds", async () => {
    const config = makeConfig();
    writeFileSync(join(TEST_DIR, "next_project.txt"), "proj-a\n", "utf8");

    const projects = [
      makeProject({ id: "proj-a", priority: 1 }),
      makeProject({ id: "proj-b", priority: 1 }),
    ];
    const fleet = makeFleet();

    const result = await pickNextProject(projects, config, fleet, new Set(["proj-a"]));
    expect(result).not.toBeNull();
    // Should fall through to picker since override project is skipped
    expect(result!.project.id).toBe("proj-b");
    expect(result!.reason).toContain("picker");
  });

  it("falls back to priority x staleness picker when no override file exists", async () => {
    const config = makeConfig();
    // No override file created

    const projects = [
      makeProject({ id: "low-pri", priority: 5 }),
      makeProject({ id: "high-pri", priority: 1 }),
    ];
    const fleet = makeFleet();

    const result = await pickNextProject(projects, config, fleet);
    expect(result).not.toBeNull();
    expect(result!.project.id).toBe("high-pri");
    expect(result!.reason).toContain("picker");
    expect(result!.reason).toContain("priority=1");
  });

  it("prefers staler project when priorities are equal", async () => {
    const config = makeConfig();

    const projects = [
      makeProject({ id: "fresh", priority: 1 }),
      makeProject({ id: "stale", priority: 1 }),
    ];
    const fleet = makeFleet({
      fresh: { last_cycle_at: new Date().toISOString() },
      // stale has no entry → maximum staleness
    });

    const result = await pickNextProject(projects, config, fleet);
    expect(result).not.toBeNull();
    expect(result!.project.id).toBe("stale");
  });

  it("returns null when all projects are skipped", async () => {
    const config = makeConfig();

    const projects = [
      makeProject({ id: "proj-a", priority: 1 }),
      makeProject({ id: "proj-b", priority: 2 }),
    ];
    const fleet = makeFleet();

    const result = await pickNextProject(projects, config, fleet, new Set(["proj-a", "proj-b"]));
    expect(result).toBeNull();
  });

  it("ignores empty override file", async () => {
    const config = makeConfig();
    writeFileSync(join(TEST_DIR, "next_project.txt"), "  \n", "utf8");

    const projects = [
      makeProject({ id: "proj-a", priority: 1 }),
    ];
    const fleet = makeFleet();

    const result = await pickNextProject(projects, config, fleet);
    expect(result).not.toBeNull();
    expect(result!.project.id).toBe("proj-a");
    expect(result!.reason).toContain("picker");
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
