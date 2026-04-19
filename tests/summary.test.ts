import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import {
  buildFleetSummary,
  buildTodaySessionSummary,
  computeDiskUsage,
  countTests,
  formatSummary,
  formatTodaySessionSummary,
} from "../src/summary";
import { setRootDir } from "../src/state";

const TEST_DIR = join(import.meta.dir, "fixtures", "summary_test");

function cycleEnd(opts: {
  project: string;
  cycleId: string;
  ts: string;
  outcome: string;
  durationSeconds?: number;
}): string {
  return JSON.stringify({
    timestamp: opts.ts,
    event: "cycle_end",
    cycle_id: opts.cycleId,
    project_id: opts.project,
    data: {
      outcome: opts.outcome,
      duration_seconds: opts.durationSeconds ?? 60,
      start_sha: "aaa1111",
      end_sha: "bbb2222",
    },
  });
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("buildFleetSummary", () => {
  it("returns empty summary when state dir does not exist", async () => {
    rmSync(join(TEST_DIR, "state"), { recursive: true, force: true });
    const s = await buildFleetSummary();
    expect(s.projects).toBe(0);
    expect(s.cycles_total).toBe(0);
    expect(s.duration_seconds).toBe(0);
    expect(s.tasks_pending).toBe(0);
    expect(s.outcomes.verified).toBe(0);
  });

  it("aggregates cycles across multiple projects with outcome + duration breakdown", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    mkdirSync(join(stateDir, "beta"), { recursive: true });

    const alphaLog = [
      cycleEnd({ project: "alpha", cycleId: "c-a1", ts: "2026-04-16T10:00:00.000Z", outcome: "verified", durationSeconds: 120 }),
      cycleEnd({ project: "alpha", cycleId: "c-a2", ts: "2026-04-16T10:05:00.000Z", outcome: "verification_failed", durationSeconds: 30 }),
      cycleEnd({ project: "alpha", cycleId: "c-a3", ts: "2026-04-16T10:10:00.000Z", outcome: "cycle_skipped", durationSeconds: 5 }),
    ].join("\n") + "\n";
    const betaLog = [
      cycleEnd({ project: "beta", cycleId: "c-b1", ts: "2026-04-16T11:00:00.000Z", outcome: "verified", durationSeconds: 90 }),
      cycleEnd({ project: "beta", cycleId: "c-b2", ts: "2026-04-16T11:05:00.000Z", outcome: "verified_weak", durationSeconds: 60 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), alphaLog);
    writeFileSync(join(stateDir, "beta", "PROGRESS.jsonl"), betaLog);

    const s = await buildFleetSummary();
    expect(s.projects).toBe(2);
    expect(s.cycles_total).toBe(5);
    expect(s.outcomes.verified).toBe(2);
    expect(s.outcomes.verified_weak).toBe(1);
    expect(s.outcomes.verification_failed).toBe(1);
    expect(s.outcomes.cycle_skipped).toBe(1);
    expect(s.duration_seconds).toBe(120 + 30 + 5 + 90 + 60);
  });

  it("counts pending tasks per project and skips done/skipped statuses", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    mkdirSync(join(stateDir, "beta"), { recursive: true });

    writeFileSync(
      join(stateDir, "alpha", "tasks.json"),
      JSON.stringify([
        { id: "a-1", title: "t1", status: "pending", priority: 1 },
        { id: "a-2", title: "t2", status: "done", priority: 1 },
        { id: "a-3", title: "t3", status: "in_progress", priority: 1 },
        { id: "a-4", title: "t4", status: "skipped", priority: 1 },
      ]),
    );
    writeFileSync(
      join(stateDir, "beta", "tasks.json"),
      JSON.stringify([
        { id: "b-1", title: "t1", status: "pending", priority: 2 },
        { id: "b-2", title: "t2", status: "pending", priority: 2 },
      ]),
    );

    const s = await buildFleetSummary();
    expect(s.tasks_pending).toBe(2 + 2); // alpha: pending+in_progress, beta: 2 pending
    expect(s.tasks_by_project.alpha).toBe(2);
    expect(s.tasks_by_project.beta).toBe(2);
  });

  it("omits projects from tasks_by_project when they have zero pending", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    writeFileSync(
      join(stateDir, "alpha", "tasks.json"),
      JSON.stringify([
        { id: "a-1", title: "t1", status: "done", priority: 1 },
      ]),
    );

    const s = await buildFleetSummary();
    expect(s.tasks_pending).toBe(0);
    expect(s.tasks_by_project.alpha).toBeUndefined();
  });

  it("ignores malformed PROGRESS.jsonl lines", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    const log = [
      cycleEnd({ project: "alpha", cycleId: "c-1", ts: "2026-04-16T10:00:00.000Z", outcome: "verified" }),
      "not json at all",
      "{}",
      cycleEnd({ project: "alpha", cycleId: "c-2", ts: "2026-04-16T10:05:00.000Z", outcome: "verified" }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), log);

    const s = await buildFleetSummary();
    expect(s.cycles_total).toBe(2);
    expect(s.outcomes.verified).toBe(2);
  });

  it("filters cycles and tasks to a single project when projectFilter is provided", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    mkdirSync(join(stateDir, "beta"), { recursive: true });

    writeFileSync(
      join(stateDir, "alpha", "PROGRESS.jsonl"),
      cycleEnd({ project: "alpha", cycleId: "c-a1", ts: "2026-04-16T10:00:00.000Z", outcome: "verified", durationSeconds: 120 }) + "\n",
    );
    writeFileSync(
      join(stateDir, "beta", "PROGRESS.jsonl"),
      cycleEnd({ project: "beta", cycleId: "c-b1", ts: "2026-04-16T11:00:00.000Z", outcome: "verification_failed", durationSeconds: 30 }) + "\n",
    );
    writeFileSync(
      join(stateDir, "alpha", "tasks.json"),
      JSON.stringify([{ id: "a-1", title: "t1", status: "pending", priority: 1 }]),
    );
    writeFileSync(
      join(stateDir, "beta", "tasks.json"),
      JSON.stringify([
        { id: "b-1", title: "t1", status: "pending", priority: 1 },
        { id: "b-2", title: "t2", status: "pending", priority: 1 },
      ]),
    );

    const s = await buildFleetSummary("alpha");
    expect(s.projects).toBe(1);
    expect(s.cycles_total).toBe(1);
    expect(s.outcomes.verified).toBe(1);
    expect(s.outcomes.verification_failed).toBe(0);
    expect(s.duration_seconds).toBe(120);
    expect(s.cycles_by_project.alpha).toEqual({ verified: 1, total: 1 });
    expect(s.cycles_by_project.beta).toBeUndefined();
    expect(s.tasks_pending).toBe(1);
    expect(s.tasks_by_project.alpha).toBe(1);
    expect(s.tasks_by_project.beta).toBeUndefined();
  });

  it("returns empty summary when projectFilter matches no state directory", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    writeFileSync(
      join(stateDir, "alpha", "PROGRESS.jsonl"),
      cycleEnd({ project: "alpha", cycleId: "c-1", ts: "2026-04-16T10:00:00.000Z", outcome: "verified" }) + "\n",
    );

    const s = await buildFleetSummary("ghost");
    expect(s.projects).toBe(0);
    expect(s.cycles_total).toBe(0);
    expect(Object.keys(s.cycles_by_project)).toHaveLength(0);
  });

  it("ignores non-cycle_end events", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    const log = [
      JSON.stringify({
        timestamp: "2026-04-16T10:00:00.000Z",
        event: "cycle_start",
        cycle_id: "c-1",
        project_id: "alpha",
        data: { start_sha: "aaa" },
      }),
      cycleEnd({ project: "alpha", cycleId: "c-1", ts: "2026-04-16T10:05:00.000Z", outcome: "verified", durationSeconds: 60 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), log);

    const s = await buildFleetSummary();
    expect(s.cycles_total).toBe(1);
    expect(s.duration_seconds).toBe(60);
  });
});

describe("countTests", () => {
  it("returns zero for non-existent directory", () => {
    const r = countTests(join(TEST_DIR, "no-such-dir"));
    expect(r.files).toBe(0);
    expect(r.cases).toBe(0);
  });

  it("counts .test.ts files and test/it calls, skipping fixtures", () => {
    const testsDir = join(TEST_DIR, "mock-tests");
    mkdirSync(join(testsDir, "fixtures"), { recursive: true });
    mkdirSync(join(testsDir, "helpers"), { recursive: true });

    writeFileSync(
      join(testsDir, "a.test.ts"),
      `import { describe, it, test } from "bun:test";
describe("a", () => {
  it("one", () => {});
  it("two", () => {});
  test("three", () => {});
});
`,
    );
    writeFileSync(
      join(testsDir, "helpers", "b.test.ts"),
      `it("nested one", () => {});
test.each([1,2])("case", () => {});
`,
    );
    // Fixture file that should NOT be counted
    writeFileSync(
      join(testsDir, "fixtures", "c.test.ts"),
      `it("should be skipped", () => {});\n`,
    );
    // Non-test file in tests dir
    writeFileSync(
      join(testsDir, "helper.ts"),
      `export function foo() { return 1; }\n`,
    );

    const r = countTests(testsDir);
    expect(r.files).toBe(2);
    expect(r.cases).toBe(5);
  });
});

describe("formatSummary", () => {
  const baseSummary = {
    projects: 2,
    cycles_total: 10,
    outcomes: {
      verified: 7,
      verified_weak: 1,
      verification_failed: 1,
      cycle_skipped: 1,
      other: 0,
    },
    duration_seconds: 600,
    tasks_pending: 5,
    tasks_by_project: { alpha: 3, beta: 2 },
    cycles_by_project: {
      alpha: { verified: 4, total: 5 },
      beta: { verified: 3, total: 5 },
    },
  };

  it("renders header, cycles, durations, tasks, tests", () => {
    const out = formatSummary(baseSummary, { files: 3, cases: 42 });
    expect(out).toContain("GeneralStaff Fleet Summary");
    expect(out).toContain("Projects:        2");
    expect(out).toContain("Total:         10");
    expect(out).toContain("Verified:      7");
    expect(out).toContain("Failed:        1");
    expect(out).toContain("Skipped:       1");
    expect(out).toContain("Verified-weak: 1");
    expect(out).toContain("Total:         10m");
    expect(out).toContain("Avg/cycle:     1m");
    expect(out).toContain("Pending:       5");
    expect(out).toContain("alpha: 3");
    expect(out).toContain("beta: 2");
    expect(out).toContain("Files:         3");
    expect(out).toContain("Cases:         42");
  });

  it("omits Tests section when tests=null", () => {
    const out = formatSummary(baseSummary, null);
    expect(out).not.toContain("Tests:");
    expect(out).not.toContain("Files:");
  });

  it("handles zero-cycles gracefully", () => {
    const out = formatSummary(
      {
        projects: 0,
        cycles_total: 0,
        outcomes: { verified: 0, verified_weak: 0, verification_failed: 0, cycle_skipped: 0, other: 0 },
        duration_seconds: 0,
        tasks_pending: 0,
        tasks_by_project: {},
        cycles_by_project: {},
      },
      null,
    );
    expect(out).toContain("Projects:        0");
    expect(out).toContain("Total:         0");
    expect(out).not.toContain("Avg/cycle:");
    expect(out).not.toContain("Verified:");
  });

  it("omits verified_weak row when count is zero", () => {
    const out = formatSummary(
      { ...baseSummary, outcomes: { ...baseSummary.outcomes, verified_weak: 0 } },
      null,
    );
    expect(out).not.toContain("Verified-weak");
  });

  it("renders Disk Usage section when disk is provided", () => {
    const out = formatSummary(baseSummary, null, {
      logs: 2048,
      digests: 1024,
      state: 512,
      total: 2048 + 1024 + 512,
    });
    expect(out).toContain("Disk Usage:");
    expect(out).toContain("logs/:         2.0 KB");
    expect(out).toContain("digests/:      1.0 KB");
    expect(out).toContain("state/:        512 B");
    expect(out).toContain("Total:         3.5 KB");
  });

  it("renders a per-project success rate line for each project with cycles", () => {
    const out = formatSummary(baseSummary, null);
    expect(out).toContain("By project:");
    expect(out).toContain("alpha: Success rate: 80% (4/5 verified)");
    expect(out).toContain("beta: Success rate: 60% (3/5 verified)");
  });

  it("omits the By project section when no project has cycles", () => {
    const out = formatSummary(
      { ...baseSummary, cycles_by_project: {} },
      null,
    );
    expect(out).not.toContain("By project:");
    expect(out).not.toContain("Success rate:");
  });

  it("buildFleetSummary populates cycles_by_project with verified counts", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    mkdirSync(join(stateDir, "beta"), { recursive: true });

    const alphaLog = [
      cycleEnd({ project: "alpha", cycleId: "c-a1", ts: "2026-04-16T10:00:00.000Z", outcome: "verified" }),
      cycleEnd({ project: "alpha", cycleId: "c-a2", ts: "2026-04-16T10:05:00.000Z", outcome: "verified" }),
      cycleEnd({ project: "alpha", cycleId: "c-a3", ts: "2026-04-16T10:10:00.000Z", outcome: "verification_failed" }),
    ].join("\n") + "\n";
    const betaLog = [
      cycleEnd({ project: "beta", cycleId: "c-b1", ts: "2026-04-16T11:00:00.000Z", outcome: "cycle_skipped" }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), alphaLog);
    writeFileSync(join(stateDir, "beta", "PROGRESS.jsonl"), betaLog);

    const s = await buildFleetSummary();
    expect(s.cycles_by_project.alpha).toEqual({ verified: 2, total: 3 });
    expect(s.cycles_by_project.beta).toEqual({ verified: 0, total: 1 });
  });

  it("omits Disk Usage section when disk is null or undefined", () => {
    expect(formatSummary(baseSummary, null)).not.toContain("Disk Usage");
    expect(formatSummary(baseSummary, null, null)).not.toContain("Disk Usage");
  });
});

describe("computeDiskUsage", () => {
  it("returns all zeros when none of the directories exist", () => {
    const d = computeDiskUsage(join(TEST_DIR, "no-such-root"));
    expect(d.logs).toBe(0);
    expect(d.digests).toBe(0);
    expect(d.state).toBe(0);
    expect(d.total).toBe(0);
  });

  it("sums file sizes across logs/, digests/, and state/ including nested files", () => {
    const root = join(TEST_DIR, "du-root");
    mkdirSync(join(root, "logs"), { recursive: true });
    mkdirSync(join(root, "digests"), { recursive: true });
    mkdirSync(join(root, "state", "alpha", "cycles"), { recursive: true });

    writeFileSync(join(root, "logs", "a.log"), "x".repeat(100));
    writeFileSync(join(root, "logs", "b.log"), "x".repeat(50));
    writeFileSync(join(root, "digests", "d.md"), "x".repeat(200));
    writeFileSync(join(root, "state", "alpha", "STATE.json"), "x".repeat(10));
    writeFileSync(
      join(root, "state", "alpha", "cycles", "c1.txt"),
      "x".repeat(5),
    );

    const d = computeDiskUsage(root);
    expect(d.logs).toBe(150);
    expect(d.digests).toBe(200);
    expect(d.state).toBe(15);
    expect(d.total).toBe(365);
  });

  it("treats a partially-missing tree as 0 for absent directories", () => {
    const root = join(TEST_DIR, "du-partial");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "s.json"), "x".repeat(42));

    const d = computeDiskUsage(root);
    expect(d.logs).toBe(0);
    expect(d.digests).toBe(0);
    expect(d.state).toBe(42);
    expect(d.total).toBe(42);
  });
});

describe("buildTodaySessionSummary", () => {
  const NOW = new Date("2026-04-18T15:30:00.000Z");

  function sessionComplete(ts: string, minutes: number): string {
    return JSON.stringify({
      timestamp: ts,
      event: "session_complete",
      project_id: "_fleet",
      data: {
        duration_minutes: minutes,
        total_cycles: 1,
        total_verified: 1,
        total_failed: 0,
        stop_reason: "budget",
      },
    });
  }

  it("returns zeros when state dir does not exist", async () => {
    rmSync(join(TEST_DIR, "state"), { recursive: true, force: true });
    const s = await buildTodaySessionSummary(NOW);
    expect(s.date).toBe("2026-04-18");
    expect(s.cycles_total).toBe(0);
    expect(s.verified).toBe(0);
    expect(s.verification_failed).toBe(0);
    expect(s.avg_cycle_duration_seconds).toBe(0);
    expect(s.wall_clock_minutes).toBe(0);
    expect(s.last_session_end).toBeNull();
  });

  it("filters cross-day events to today (UTC midnight cutoff)", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    mkdirSync(join(stateDir, "_fleet"), { recursive: true });

    const alphaLog = [
      // yesterday — excluded
      cycleEnd({ project: "alpha", cycleId: "c-y1", ts: "2026-04-17T23:59:59.000Z", outcome: "verified", durationSeconds: 100 }),
      // today — included
      cycleEnd({ project: "alpha", cycleId: "c-t1", ts: "2026-04-18T00:00:01.000Z", outcome: "verified", durationSeconds: 120 }),
      cycleEnd({ project: "alpha", cycleId: "c-t2", ts: "2026-04-18T10:00:00.000Z", outcome: "verification_failed", durationSeconds: 60 }),
      cycleEnd({ project: "alpha", cycleId: "c-t3", ts: "2026-04-18T11:00:00.000Z", outcome: "verified", durationSeconds: 180 }),
    ].join("\n") + "\n";

    const fleetLog = [
      sessionComplete("2026-04-17T20:00:00.000Z", 999), // yesterday — excluded
      sessionComplete("2026-04-18T09:00:00.000Z", 30),
      sessionComplete("2026-04-18T14:00:00.000Z", 45),
    ].join("\n") + "\n";

    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), alphaLog);
    writeFileSync(join(stateDir, "_fleet", "PROGRESS.jsonl"), fleetLog);

    const s = await buildTodaySessionSummary(NOW);
    expect(s.date).toBe("2026-04-18");
    expect(s.cycles_total).toBe(3);
    expect(s.verified).toBe(2);
    expect(s.verification_failed).toBe(1);
    expect(s.avg_cycle_duration_seconds).toBe((120 + 60 + 180) / 3);
    expect(s.wall_clock_minutes).toBe(30 + 45);
    expect(s.last_session_end).toBe("2026-04-18T14:00:00.000Z");
  });

  it("aggregates cycles across multiple project dirs", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    mkdirSync(join(stateDir, "beta"), { recursive: true });

    writeFileSync(
      join(stateDir, "alpha", "PROGRESS.jsonl"),
      cycleEnd({ project: "alpha", cycleId: "c-a1", ts: "2026-04-18T10:00:00.000Z", outcome: "verified", durationSeconds: 60 }) + "\n",
    );
    writeFileSync(
      join(stateDir, "beta", "PROGRESS.jsonl"),
      cycleEnd({ project: "beta", cycleId: "c-b1", ts: "2026-04-18T11:00:00.000Z", outcome: "verification_failed", durationSeconds: 90 }) + "\n",
    );

    const s = await buildTodaySessionSummary(NOW);
    expect(s.cycles_total).toBe(2);
    expect(s.verified).toBe(1);
    expect(s.verification_failed).toBe(1);
    expect(s.avg_cycle_duration_seconds).toBe((60 + 90) / 2);
  });

  it("formatTodaySessionSummary prints one line per metric", () => {
    const s = {
      date: "2026-04-18",
      cycles_total: 5,
      verified: 4,
      verification_failed: 1,
      avg_cycle_duration_seconds: 90,
      wall_clock_minutes: 60,
      last_session_end: "2026-04-18T14:00:00.000Z",
      cycle_duration: null,
    };
    const out = formatTodaySessionSummary(s);
    const lines = out.split("\n");
    expect(lines[0]).toContain("2026-04-18");
    expect(out).toContain("Cycles total:              5");
    expect(out).toContain("Verified:                  4");
    expect(out).toContain("Verification failed:       1");
    expect(out).toContain("Total bot wall-clock:      60 min");
    expect(out).toContain("Last session end:          2026-04-18T14:00:00.000Z");
  });

  it("formats n/a when no cycles or session ends today", () => {
    const s = {
      date: "2026-04-18",
      cycles_total: 0,
      verified: 0,
      verification_failed: 0,
      avg_cycle_duration_seconds: 0,
      wall_clock_minutes: 0,
      last_session_end: null,
      cycle_duration: null,
    };
    const out = formatTodaySessionSummary(s);
    expect(out).toContain("Average cycle duration:    n/a");
    expect(out).toContain("Last session end:          n/a");
  });
});

describe("buildTodaySessionSummary cycle_duration percentiles (gs-252)", () => {
  const NOW = new Date("2026-04-18T15:30:00.000Z");

  it("computes p50/p90/max from a 3-cycle fixture (nearest-rank)", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    const log = [
      cycleEnd({ project: "alpha", cycleId: "c1", ts: "2026-04-18T10:00:00.000Z", outcome: "verified", durationSeconds: 60 }),
      cycleEnd({ project: "alpha", cycleId: "c2", ts: "2026-04-18T10:05:00.000Z", outcome: "verified", durationSeconds: 120 }),
      cycleEnd({ project: "alpha", cycleId: "c3", ts: "2026-04-18T10:10:00.000Z", outcome: "verified", durationSeconds: 180 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), log);

    const s = await buildTodaySessionSummary(NOW);
    // Sorted [60, 120, 180]: p50 → ceil(0.5*3)=2 → idx 1 → 120;
    // p90 → ceil(0.9*3)=3 → idx 2 → 180; max = 180.
    expect(s.cycle_duration).toEqual({ p50: 120, p90: 180, max: 180, count: 3 });
  });

  it("emits null cycle_duration when the pool is empty", async () => {
    rmSync(join(TEST_DIR, "state"), { recursive: true, force: true });
    const s = await buildTodaySessionSummary(NOW);
    expect(s.cycle_duration).toBeNull();
    const out = formatTodaySessionSummary(s);
    expect(out).toContain("cycle_duration:            (no cycles)");
  });

  it("respects the --since cutoff: percentiles span only filtered events", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    const log = [
      // Pre-cutoff — excluded.
      cycleEnd({ project: "alpha", cycleId: "c0", ts: "2026-04-18T08:00:00.000Z", outcome: "verified", durationSeconds: 9999 }),
      // Inside the window — counted.
      cycleEnd({ project: "alpha", cycleId: "c1", ts: "2026-04-18T11:00:00.000Z", outcome: "verified", durationSeconds: 30 }),
      cycleEnd({ project: "alpha", cycleId: "c2", ts: "2026-04-18T11:05:00.000Z", outcome: "verified", durationSeconds: 90 }),
    ].join("\n") + "\n";
    writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), log);

    const cutoffMs = Date.parse("2026-04-18T10:00:00.000Z");
    const s = await buildTodaySessionSummary(NOW, cutoffMs);
    expect(s.cycle_duration).toEqual({ p50: 30, p90: 90, max: 90, count: 2 });
  });

  it("single-cycle edge case: p50 = p90 = max equals that one duration", async () => {
    const stateDir = join(TEST_DIR, "state");
    mkdirSync(join(stateDir, "alpha"), { recursive: true });
    writeFileSync(
      join(stateDir, "alpha", "PROGRESS.jsonl"),
      cycleEnd({ project: "alpha", cycleId: "c1", ts: "2026-04-18T10:00:00.000Z", outcome: "verified", durationSeconds: 77 }) + "\n",
    );
    const s = await buildTodaySessionSummary(NOW);
    expect(s.cycle_duration).toEqual({ p50: 77, p90: 77, max: 77, count: 1 });
  });

  it("formatTodaySessionSummary renders p50/p90/max line", () => {
    const s = {
      date: "2026-04-18",
      cycles_total: 3,
      verified: 3,
      verification_failed: 0,
      avg_cycle_duration_seconds: 120,
      wall_clock_minutes: 6,
      last_session_end: "2026-04-18T11:00:00.000Z",
      cycle_duration: { p50: 120, p90: 180, max: 180, count: 3 },
    };
    const out = formatTodaySessionSummary(s);
    expect(out).toContain("cycle_duration:            p50=120s p90=180s max=180s");
  });
});
