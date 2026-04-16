import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeDigest, formatSessionPlanPreview } from "../src/session";
import { setRootDir } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "fs";
import type { CycleResult } from "../src/types";
import type { SessionPlanEstimate } from "../src/dispatcher";

async function runHelperSubprocess(helperName: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  result: Record<string, unknown>;
}> {
  const helperPath = join(import.meta.dir, "helpers", helperName);
  const proc = Bun.spawn(["bun", "run", helperPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const lastLine = stdout.trim().split("\n").pop() ?? "{}";
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(lastLine);
  } catch {
    // leave empty if no JSON line
  }
  return { exitCode, stdout, stderr, result };
}

const TEST_DIR = join(import.meta.dir, "fixtures", "digest_test");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeCycleResult(overrides: Partial<CycleResult> = {}): CycleResult {
  return {
    cycle_id: "cycle-001",
    project_id: "test-proj",
    started_at: "2026-04-16T10:00:00.000Z",
    ended_at: "2026-04-16T10:05:00.000Z",
    cycle_start_sha: "abcdef1234567890",
    cycle_end_sha: "1234567890abcdef",
    engineer_exit_code: 0,
    verification_outcome: "passed",
    reviewer_verdict: "verified",
    final_outcome: "verified",
    reason: "all tests pass",
    ...overrides,
  };
}

describe("writeDigest", () => {
  it("creates digest directory and writes a markdown file", async () => {
    const results = [makeCycleResult()];
    await writeDigest(results, 5.2, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^digest_\d{8}_\d{6}\.md$/);
  });

  it("includes header with date, duration, and cycle count", async () => {
    const results = [makeCycleResult(), makeCycleResult({ cycle_id: "cycle-002", project_id: "proj-b" })];
    await writeDigest(results, 12.5, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("# GeneralStaff Session Digest");
    expect(content).toContain("**Duration:** 12m30s");
    expect(content).toContain("**Cycles:** 2");
    expect(content).toMatch(/\*\*Date:\*\* \d{4}-\d{2}-\d{2}T/);
  });

  it("includes cycle outcomes with correct fields", async () => {
    const result = makeCycleResult({
      project_id: "catalogdna",
      cycle_id: "cycle-042",
      final_outcome: "verified",
      reason: "tests pass, scope matches",
      engineer_exit_code: 0,
      verification_outcome: "passed",
      reviewer_verdict: "verified",
    });
    await writeDigest([result], 3.0, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("## catalogdna — cycle-042");
    expect(content).toContain("- **Outcome:** verified");
    expect(content).toContain("- **Reason:** tests pass, scope matches");
    expect(content).toContain("- **Engineer exit:** 0");
    expect(content).toContain("- **Verification:** passed");
    expect(content).toContain("- **Reviewer:** verified");
  });

  it("truncates SHAs to 8 characters", async () => {
    const result = makeCycleResult({
      cycle_start_sha: "abcdef1234567890",
      cycle_end_sha: "1234567890abcdef",
    });
    await writeDigest([result], 1.0, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("**SHA:** abcdef12 → 12345678");
    // Full SHAs should not appear
    expect(content).not.toContain("abcdef1234567890");
    expect(content).not.toContain("1234567890abcdef");
  });

  it("includes sections for multiple cycle results", async () => {
    const results = [
      makeCycleResult({ project_id: "proj-a", cycle_id: "c-1", final_outcome: "verified" }),
      makeCycleResult({ project_id: "proj-b", cycle_id: "c-2", final_outcome: "verification_failed", reason: "lint errors" }),
      makeCycleResult({ project_id: "proj-a", cycle_id: "c-3", final_outcome: "verified_weak", reason: "minor scope drift" }),
    ];
    await writeDigest(results, 15.0, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("## proj-a — c-1");
    expect(content).toContain("## proj-b — c-2");
    expect(content).toContain("## proj-a — c-3");
    expect(content).toContain("- **Outcome:** verification_failed");
    expect(content).toContain("- **Reason:** lint errors");
    expect(content).toContain("- **Outcome:** verified_weak");
    expect(content).toContain("- **Reason:** minor scope drift");
  });

  it("creates digest directory if it does not exist", async () => {
    const results = [makeCycleResult()];
    await writeDigest(results, 1.0, { digest_dir: "nested/deep/digests" });

    const digestDir = join(TEST_DIR, "nested", "deep", "digests");
    const files = readdirSync(digestDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^digest_.*\.md$/);
  });

  it("writes empty-cycle digest when results array is empty", async () => {
    await writeDigest([], 0.5, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    expect(files).toHaveLength(1);

    const content = readFileSync(join(digestDir, files[0]), "utf8");
    expect(content).toContain("**Cycles:** 0");
    // No cycle sections
    expect(content).not.toContain("##");
  });
});

function makePlan(overrides: Partial<SessionPlanEstimate> = {}): SessionPlanEstimate {
  return {
    picks: [],
    per_project: [],
    total_cycles: 0,
    budget_used_minutes: 0,
    budget_remaining_minutes: 0,
    ...overrides,
  };
}

describe("formatSessionPlanPreview", () => {
  it("includes a header", () => {
    const out = formatSessionPlanPreview(
      makePlan({
        picks: [{ project_id: "a", start_minute: 0, duration_minutes: 30 }],
        per_project: [{ project_id: "a", cycle_count: 1 }],
        total_cycles: 1,
        budget_used_minutes: 30,
        budget_remaining_minutes: 90,
      }),
    );
    expect(out).toContain("=== Session Plan Preview ===");
  });

  it("shows total cycles and budget usage", () => {
    const out = formatSessionPlanPreview(
      makePlan({
        picks: [
          { project_id: "a", start_minute: 0, duration_minutes: 30 },
          { project_id: "b", start_minute: 30, duration_minutes: 30 },
        ],
        per_project: [
          { project_id: "a", cycle_count: 1 },
          { project_id: "b", cycle_count: 1 },
        ],
        total_cycles: 2,
        budget_used_minutes: 60,
        budget_remaining_minutes: 60,
      }),
    );
    expect(out).toContain("Total: 2 cycle(s)");
    expect(out).toContain("60 min used");
    expect(out).toContain("60 min remaining");
  });

  it("renders a per-project row for each project", () => {
    const out = formatSessionPlanPreview(
      makePlan({
        picks: [
          { project_id: "catalogdna", start_minute: 0, duration_minutes: 30 },
        ],
        per_project: [
          { project_id: "catalogdna", cycle_count: 3 },
          { project_id: "retrogaze", cycle_count: 1 },
        ],
        total_cycles: 4,
        budget_used_minutes: 120,
        budget_remaining_minutes: 0,
      }),
    );
    expect(out).toContain("catalogdna");
    expect(out).toContain("retrogaze");
    // Verify the counts appear next to project ids
    expect(out).toMatch(/catalogdna\s+3/);
    expect(out).toMatch(/retrogaze\s+1/);
  });

  it("reports empty plan when no cycles fit the budget", () => {
    const out = formatSessionPlanPreview(
      makePlan({
        budget_remaining_minutes: 10,
      }),
    );
    expect(out).toContain("No cycles fit in the budget.");
  });

  it("includes Project and Cycles column headers when non-empty", () => {
    const out = formatSessionPlanPreview(
      makePlan({
        picks: [{ project_id: "x", start_minute: 0, duration_minutes: 30 }],
        per_project: [{ project_id: "x", cycle_count: 1 }],
        total_cycles: 1,
        budget_used_minutes: 30,
        budget_remaining_minutes: 0,
      }),
    );
    expect(out).toContain("Project");
    expect(out).toContain("Cycles");
  });
});

describe("runSession safeguards", () => {
  it("exits after 3 consecutive empty-diff cycles", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_empty_cycle_guard.ts",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.execute_cycle_calls).toBe(3);
    expect(result.result_count).toBe(3);
  }, 30_000);

  it("logs cycle completion with project, outcome, and remaining budget", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_cycle_completion_log.ts",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.execute_cycle_calls).toBe(1);
    expect(result.result_count).toBe(1);
    expect(String(result.captured)).toMatch(
      /Cycle 1 completed: test-proj \u2014 verified \([^)]+ remaining\)/,
    );
  }, 30_000);

  it("adds capped projects to the skip set", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_capped_projects_skipped.ts",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    // 2 cycles run before cap fires
    expect(result.execute_cycle_calls).toBe(2);
    expect(result.result_count).toBe(2);
    // pickNextProject called twice: once initially (empty skip set),
    // once after cap (skip set contains the capped project id)
    const snapshots = result.pick_skip_snapshots as string[][];
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]).toEqual([]);
    expect(snapshots[snapshots.length - 1]).toContain("test-proj");
  }, 30_000);
});
