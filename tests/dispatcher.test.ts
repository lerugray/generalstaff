import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  scoreProjects,
  shouldChain,
  pickNextProject,
  pickNextProjects,
  estimateSessionPlan,
} from "../src/dispatcher";
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
    max_parallel_slots: 1,
    max_consecutive_empty: 3,
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

describe("pickNextProjects (gs-185 / Phase 4 picker)", () => {
  // gs-232: in parallel mode (maxCount > 1) the picker now consults
  // hasMoreWork() and skips empty-queue projects. Tests in this block
  // that exercise N > 1 must seed a pending tasks.json entry for each
  // project or they would be filtered out. The helper below mirrors
  // `greenfieldHasMoreWork`'s expected layout: <projectPath>/state/
  // <projectId>/tasks.json with at least one "pending" entry.
  function seedProjectWithWork(
    id: string,
    overrides: Partial<ProjectConfig> = {},
  ): ProjectConfig {
    const projectPath = join(TEST_DIR, "projects", id);
    const tasksDir = join(projectPath, "state", id);
    mkdirSync(tasksDir, { recursive: true });
    const tasks = [
      {
        id: `${id}-001`,
        title: `${id} placeholder pending task`,
        status: "pending",
        priority: 1,
      },
    ];
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify(tasks), "utf8");
    return makeProject({ id, path: projectPath, ...overrides });
  }

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setRootDir(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("maxCount=0 returns an empty array", async () => {
    const config = makeConfig();
    const projects = [
      makeProject({ id: "a", priority: 1 }),
      makeProject({ id: "b", priority: 1 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(projects, config, fleet, new Set(), 0);
    expect(picks).toEqual([]);
  });

  it("maxCount=1 matches pickNextProject (back-compat for sequential dispatch)", async () => {
    // Sequential mode: empty-queue filter is intentionally NOT applied
    // (gs-232), so these `/tmp/test`-path projects still pick normally.
    const config = makeConfig();
    const projects = [
      makeProject({ id: "low-pri", priority: 5 }),
      makeProject({ id: "high-pri", priority: 1 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(projects, config, fleet, new Set(), 1);
    expect(picks.length).toBe(1);
    expect(picks[0].project.id).toBe("high-pri");
    expect(picks[0].reason).toContain("picker");
  });

  it("maxCount=N returns up to N distinct picks in score order", async () => {
    const config = makeConfig();
    const projects = [
      seedProjectWithWork("a", { priority: 1 }),
      seedProjectWithWork("b", { priority: 2 }),
      seedProjectWithWork("c", { priority: 3 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(projects, config, fleet, new Set(), 3);
    expect(picks.length).toBe(3);
    expect(picks.map((p) => p.project.id)).toEqual(["a", "b", "c"]);
    // No duplicates.
    const ids = new Set(picks.map((p) => p.project.id));
    expect(ids.size).toBe(3);
  });

  it("returns fewer than maxCount when fewer projects are eligible", async () => {
    const config = makeConfig();
    const projects = [
      seedProjectWithWork("a", { priority: 1 }),
      seedProjectWithWork("b", { priority: 2 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(projects, config, fleet, new Set(), 5);
    expect(picks.length).toBe(2);
  });

  it("respects skipProjectIds when filling multiple slots", async () => {
    const config = makeConfig();
    const projects = [
      seedProjectWithWork("skipped", { priority: 1 }),
      seedProjectWithWork("a", { priority: 2 }),
      seedProjectWithWork("b", { priority: 3 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(
      projects,
      config,
      fleet,
      new Set(["skipped"]),
      3,
    );
    expect(picks.map((p) => p.project.id)).toEqual(["a", "b"]);
  });

  it("override file claims the first slot, picker fills the remaining slots", async () => {
    const config = makeConfig();
    writeFileSync(join(TEST_DIR, "next_project.txt"), "lo\n", "utf8");
    const projects = [
      seedProjectWithWork("hi", { priority: 1 }),
      seedProjectWithWork("lo", { priority: 5 }),
      seedProjectWithWork("med", { priority: 3 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(projects, config, fleet, new Set(), 3);
    expect(picks.length).toBe(3);
    expect(picks[0].project.id).toBe("lo");
    expect(picks[0].reason).toContain("override");
    // remaining slots come from priority × staleness: hi (1) then med (3)
    expect(picks[1].project.id).toBe("hi");
    expect(picks[1].reason).toContain("picker");
    expect(picks[2].project.id).toBe("med");
    expect(picks[2].reason).toContain("picker");
  });

  it("never returns the override project twice when it would also rank first", async () => {
    const config = makeConfig();
    writeFileSync(join(TEST_DIR, "next_project.txt"), "hi\n", "utf8");
    const projects = [
      seedProjectWithWork("hi", { priority: 1 }),
      seedProjectWithWork("lo", { priority: 5 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(projects, config, fleet, new Set(), 2);
    expect(picks.length).toBe(2);
    expect(picks.map((p) => p.project.id)).toEqual(["hi", "lo"]);
    expect(picks[0].reason).toContain("override");
    expect(picks[1].reason).toContain("picker");
  });

  it("empty project list returns []", async () => {
    const config = makeConfig();
    const picks = await pickNextProjects([], config, makeFleet(), new Set(), 3);
    expect(picks).toEqual([]);
  });

  it("all projects skipped returns []", async () => {
    const config = makeConfig();
    const projects = [
      makeProject({ id: "a", priority: 1 }),
      makeProject({ id: "b", priority: 1 }),
    ];
    const fleet = makeFleet();
    const picks = await pickNextProjects(
      projects,
      config,
      fleet,
      new Set(["a", "b"]),
      5,
    );
    expect(picks).toEqual([]);
  });
});

// gs-232: in parallel mode (maxCount > 1) the picker consults
// hasMoreWork() and skips projects whose queue is empty — avoids the
// wave-3/4 failure mode where half the parallel slots burned ~30-60s
// each on empty-diff verified_weak cycles from queue-empty projects.
// Sequential mode (N=1) stays bit-for-bit identical (verified by the
// back-compat case at the end).
describe("pickNextProjects empty-queue filter (gs-232)", () => {
  const EMPTY_QUEUE_DIR = join(
    import.meta.dir,
    "fixtures",
    "dispatcher_empty_queue",
  );

  // Build a project path whose state/<id>/tasks.json holds one pending
  // task — greenfieldHasMoreWork() will return true for it.
  function makeProjectWithWork(id: string, priority = 1): ProjectConfig {
    const projectPath = join(EMPTY_QUEUE_DIR, id);
    const tasksDir = join(projectPath, "state", id);
    mkdirSync(tasksDir, { recursive: true });
    const tasks = [
      {
        id: `${id}-001`,
        title: "placeholder pending task",
        status: "pending",
        priority: 1,
      },
    ];
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify(tasks), "utf8");
    return makeProject({ id, path: projectPath, priority });
  }

  // An empty-queue project: path exists but no tasks.json → hasMoreWork=false.
  function makeProjectEmpty(id: string, priority = 1): ProjectConfig {
    const projectPath = join(EMPTY_QUEUE_DIR, id);
    mkdirSync(projectPath, { recursive: true });
    return makeProject({ id, path: projectPath, priority });
  }

  beforeEach(() => {
    mkdirSync(EMPTY_QUEUE_DIR, { recursive: true });
    setRootDir(EMPTY_QUEUE_DIR);
  });

  afterEach(() => {
    rmSync(EMPTY_QUEUE_DIR, { recursive: true, force: true });
  });

  it("(a) parallel mode: 2-project fleet, 1 with work → picks only the one with work", async () => {
    const config = makeConfig({ max_parallel_slots: 2 });
    const projects = [
      makeProjectWithWork("has-work", 1),
      makeProjectEmpty("empty", 1),
    ];
    const fleet = makeFleet();

    const picks = await pickNextProjects(projects, config, fleet, new Set(), 2);
    expect(picks.length).toBe(1);
    expect(picks[0].project.id).toBe("has-work");
  });

  it("(b) parallel mode: both projects empty → returns []", async () => {
    const config = makeConfig({ max_parallel_slots: 2 });
    const projects = [
      makeProjectEmpty("empty-a", 1),
      makeProjectEmpty("empty-b", 1),
    ];
    const fleet = makeFleet();

    const picks = await pickNextProjects(projects, config, fleet, new Set(), 2);
    expect(picks).toEqual([]);
  });

  it("(c) parallel mode: 3 projects, 2 with work → pickNextProjects(2) returns both with-work projects", async () => {
    const config = makeConfig({ max_parallel_slots: 2 });
    const projects = [
      makeProjectEmpty("empty", 1), // priority 1 → would rank first without the filter
      makeProjectWithWork("work-a", 2),
      makeProjectWithWork("work-b", 3),
    ];
    const fleet = makeFleet();

    const picks = await pickNextProjects(projects, config, fleet, new Set(), 2);
    expect(picks.length).toBe(2);
    const ids = picks.map((p) => p.project.id).sort();
    expect(ids).toEqual(["work-a", "work-b"]);
  });

  it("(d) back-compat: sequential mode (N=1) does NOT consult hasMoreWork — empty-queue project can still be picked", async () => {
    // Pre-gs-232 contract: pickNextProject returns the picker's best
    // guess regardless of queue depth. The downstream shouldChain /
    // hasMoreWork gates handle empty-queue cases. Changing N=1 here
    // would silently break session.ts's sequential loop, dry-run
    // previews, and every existing call site.
    const config = makeConfig({ max_parallel_slots: 1 });
    const projects = [makeProjectEmpty("only-empty", 1)];
    const fleet = makeFleet();

    const picks = await pickNextProjects(projects, config, fleet, new Set(), 1);
    expect(picks.length).toBe(1);
    expect(picks[0].project.id).toBe("only-empty");
  });

  it("(d.2) back-compat: N=1 picks the priority-winner even if its queue is empty", async () => {
    // Same story with a 2-project fleet — sequential mode keeps
    // priority × staleness as the sole signal at pick time.
    const config = makeConfig({ max_parallel_slots: 1 });
    const projects = [
      makeProjectEmpty("empty-hi", 1),
      makeProjectWithWork("work-lo", 5),
    ];
    const fleet = makeFleet();

    const picks = await pickNextProjects(projects, config, fleet, new Set(), 1);
    expect(picks.length).toBe(1);
    expect(picks[0].project.id).toBe("empty-hi");
  });

  it("parallel mode: override file pointing at empty-queue project is skipped; picker fills from projects with work", async () => {
    const config = makeConfig({ max_parallel_slots: 2 });
    writeFileSync(
      join(EMPTY_QUEUE_DIR, "next_project.txt"),
      "empty\n",
      "utf8",
    );
    const projects = [
      makeProjectEmpty("empty", 1),
      makeProjectWithWork("work-a", 2),
      makeProjectWithWork("work-b", 3),
    ];
    const fleet = makeFleet();

    const picks = await pickNextProjects(projects, config, fleet, new Set(), 2);
    expect(picks.length).toBe(2);
    // Override project had no work → not picked; picker fills both slots
    // from the work-a / work-b pool in priority order.
    expect(picks.map((p) => p.project.id)).toEqual(["work-a", "work-b"]);
    expect(picks[0].reason).toContain("picker");
  });
});

describe("estimateSessionPlan", () => {
  it("returns an empty plan when budget is too small for any cycle", () => {
    const projects = [
      makeProject({ id: "a", priority: 1, cycle_budget_minutes: 60 }),
    ];
    const plan = estimateSessionPlan(projects, makeFleet(), 10);
    expect(plan.total_cycles).toBe(0);
    expect(plan.picks).toEqual([]);
    expect(plan.budget_used_minutes).toBe(0);
    expect(plan.budget_remaining_minutes).toBe(10);
    expect(plan.per_project).toEqual([{ project_id: "a", cycle_count: 0 }]);
  });

  it("fills budget with a single project when only one is registered", () => {
    const projects = [
      makeProject({ id: "solo", priority: 1, cycle_budget_minutes: 25 }),
    ];
    const plan = estimateSessionPlan(projects, makeFleet(), 120);
    // Each cycle uses 25 + 5 = 30 min → 4 cycles in 120 min
    expect(plan.total_cycles).toBe(4);
    expect(plan.budget_used_minutes).toBe(120);
    expect(plan.budget_remaining_minutes).toBe(0);
    expect(plan.picks.map((p) => p.project_id)).toEqual(["solo", "solo", "solo", "solo"]);
    expect(plan.picks.map((p) => p.start_minute)).toEqual([0, 30, 60, 90]);
    expect(plan.per_project).toEqual([{ project_id: "solo", cycle_count: 4 }]);
  });

  it("rotates between projects of equal priority", () => {
    const projects = [
      makeProject({ id: "a", priority: 1, cycle_budget_minutes: 25 }),
      makeProject({ id: "b", priority: 1, cycle_budget_minutes: 25 }),
    ];
    const plan = estimateSessionPlan(projects, makeFleet(), 120);
    // 4 cycles total, should alternate between a and b
    expect(plan.total_cycles).toBe(4);
    const counts = new Map(plan.per_project.map((p) => [p.project_id, p.cycle_count]));
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(2);
  });

  it("prefers higher priority project when mixing", () => {
    const projects = [
      makeProject({ id: "hi", priority: 1, cycle_budget_minutes: 25 }),
      makeProject({ id: "lo", priority: 10, cycle_budget_minutes: 25 }),
    ];
    const plan = estimateSessionPlan(projects, makeFleet(), 120);
    const counts = new Map(plan.per_project.map((p) => [p.project_id, p.cycle_count]));
    expect(counts.get("hi")).toBeGreaterThan(counts.get("lo") ?? 0);
    // First pick should be the higher priority project
    expect(plan.picks[0].project_id).toBe("hi");
  });

  it("respects maxCyclesPerProject cap", () => {
    const projects = [
      makeProject({ id: "a", priority: 1, cycle_budget_minutes: 25 }),
      makeProject({ id: "b", priority: 10, cycle_budget_minutes: 25 }),
    ];
    const plan = estimateSessionPlan(projects, makeFleet(), 300, 2);
    const counts = new Map(plan.per_project.map((p) => [p.project_id, p.cycle_count]));
    expect(counts.get("a")).toBeLessThanOrEqual(2);
    expect(counts.get("b")).toBeLessThanOrEqual(2);
  });

  it("stops when budget cannot fit another cycle", () => {
    const projects = [
      makeProject({ id: "a", priority: 1, cycle_budget_minutes: 60 }),
    ];
    // 125 min budget: first cycle takes 65 min, second would take 65 more = 130 > 125
    const plan = estimateSessionPlan(projects, makeFleet(), 125);
    expect(plan.total_cycles).toBe(1);
    expect(plan.budget_used_minutes).toBe(65);
    expect(plan.budget_remaining_minutes).toBe(60);
  });

  it("does not mutate the input fleet state", () => {
    const fleet = makeFleet({
      a: { total_cycles: 5, last_cycle_at: "2026-01-01T00:00:00.000Z" },
    });
    const fleetBefore = JSON.parse(JSON.stringify(fleet));
    const projects = [makeProject({ id: "a", priority: 1, cycle_budget_minutes: 25 })];
    estimateSessionPlan(projects, fleet, 60);
    expect(fleet).toEqual(fleetBefore);
  });

  it("returns empty plan when projects list is empty", () => {
    const plan = estimateSessionPlan([], makeFleet(), 120);
    expect(plan.total_cycles).toBe(0);
    expect(plan.picks).toEqual([]);
    expect(plan.per_project).toEqual([]);
    expect(plan.budget_remaining_minutes).toBe(120);
  });

  it("with three mixed-priority projects and a per-project cap, picks in priority order and stops at the cap", () => {
    // Three projects at different priorities; ample budget so the cap
    // (not the budget) is what bounds the cycle count.
    const projects = [
      makeProject({ id: "p1", priority: 1, cycle_budget_minutes: 25 }),
      makeProject({ id: "p2", priority: 2, cycle_budget_minutes: 25 }),
      makeProject({ id: "p3", priority: 3, cycle_budget_minutes: 25 }),
    ];
    const plan = estimateSessionPlan(projects, makeFleet(), 1000, 2);

    // Cap = 2 per project × 3 projects = 6 total cycles
    const counts = new Map(
      plan.per_project.map((p) => [p.project_id, p.cycle_count]),
    );
    expect(counts.get("p1")).toBe(2);
    expect(counts.get("p2")).toBe(2);
    expect(counts.get("p3")).toBe(2);
    expect(plan.total_cycles).toBe(6);

    // Unrun projects win on staleness; among them highest priority wins first.
    // Once all have run once, staleness is ~equal so priority alone rotates.
    // Expected sequence: p1, p2, p3, p1, p2, p3.
    expect(plan.picks.map((p) => p.project_id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p1",
      "p2",
      "p3",
    ]);

    // Start minutes should be strictly increasing by 30 (25 cycle + 5 overhead)
    expect(plan.picks.map((p) => p.start_minute)).toEqual([
      0, 30, 60, 90, 120, 150,
    ]);
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
