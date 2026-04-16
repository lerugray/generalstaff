import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import {
  buildFleetSummary,
  countTests,
  formatSummary,
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
});
