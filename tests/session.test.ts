import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeDigest, formatSessionPlanPreview, parseDigest } from "../src/session";
import { setRootDir } from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "fs";
import type { CycleResult } from "../src/types";
import type { SessionPlanEstimate } from "../src/dispatcher";

async function runHelperSubprocess(helperName: string, ...helperArgs: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  result: Record<string, unknown>;
}> {
  const helperPath = join(import.meta.dir, "helpers", helperName);
  const proc = Bun.spawn(["bun", "run", helperPath, ...helperArgs], {
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
    // Empty results: skip all section headers and Summary line
    expect(content).not.toContain("##");
    expect(content).not.toContain("**Summary:**");
  });

  it("includes Summary line with verified/failed counts when results present", async () => {
    const results = [
      makeCycleResult({ cycle_id: "c-1", final_outcome: "verified" }),
      makeCycleResult({ cycle_id: "c-2", final_outcome: "verification_failed" }),
      makeCycleResult({ cycle_id: "c-3", final_outcome: "verified_weak" }),
    ];
    await writeDigest(results, 10, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("**Summary:** 2 verified, 1 failed");
  });

  it("renders a 'What got done' section listing verified cycles", async () => {
    const results = [
      makeCycleResult({
        cycle_id: "cycle-aaa",
        final_outcome: "verified",
        diff_stats: { files_changed: 3, insertions: 42, deletions: 5 },
      }),
      makeCycleResult({
        cycle_id: "cycle-bbb",
        final_outcome: "verified_weak",
        diff_stats: { files_changed: 1, insertions: 8, deletions: 0 },
      }),
    ];
    await writeDigest(results, 5, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("## What got done");
    // Fake SHAs won't resolve to a commit subject, so label falls back to cycle_id
    expect(content).toMatch(/1\. cycle-aaa\s+_\(3 files, \+42\/-5\)_/);
    expect(content).toMatch(/2\. cycle-bbb\s+_\(1 file, \+8\/-0\)_/);
  });

  it("renders an 'Issues' section with 'None' when all cycles verified", async () => {
    const results = [makeCycleResult({ final_outcome: "verified" })];
    await writeDigest(results, 3, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("## Issues");
    expect(content).toContain("_None — all cycles passed verification._");
  });

  it("renders an 'Issues' section listing failed cycles with reasons", async () => {
    const results = [
      makeCycleResult({ cycle_id: "ok", final_outcome: "verified" }),
      makeCycleResult({
        cycle_id: "bad-cycle-id",
        final_outcome: "verification_failed",
        reason: "reviewer rejected scope drift",
      }),
    ];
    await writeDigest(results, 3, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    expect(content).toContain("## Issues");
    expect(content).toContain(
      "**bad-cycle-id** — verification_failed: reviewer rejected scope drift",
    );
  });

  it("places detailed per-cycle blocks after a '## Details' divider", async () => {
    const results = [makeCycleResult({ project_id: "myproj", cycle_id: "c-42" })];
    await writeDigest(results, 1, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");

    // Details block precedes the per-cycle section header
    const detailsIdx = content.indexOf("## Details");
    const cycleIdx = content.indexOf("## myproj — c-42");
    expect(detailsIdx).toBeGreaterThan(-1);
    expect(cycleIdx).toBeGreaterThan(detailsIdx);
  });

  it("defaults reviewer header to 'claude' when provider is unset", async () => {
    await writeDigest([makeCycleResult()], 1, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");
    expect(content).toContain("**Reviewer:** claude\n");
  });

  it("renders reviewer header for openrouter with model", async () => {
    await writeDigest([makeCycleResult()], 1, {
      digest_dir: "digests",
      reviewer_provider: "openrouter",
      reviewer_model: "qwen/qwen3-coder-30b-a3b-instruct",
    });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");
    expect(content).toContain(
      "**Reviewer:** openrouter (qwen/qwen3-coder-30b-a3b-instruct)\n",
    );
  });

  it("renders reviewer header for ollama with model", async () => {
    await writeDigest([makeCycleResult()], 1, {
      digest_dir: "digests",
      reviewer_provider: "ollama",
      reviewer_model: "qwen3:8b",
    });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");
    expect(content).toContain("**Reviewer:** ollama (qwen3:8b)\n");
  });

  it("passes through an unknown provider name (lowercased, no model)", async () => {
    await writeDigest([makeCycleResult()], 1, {
      digest_dir: "digests",
      reviewer_provider: "MyCustomProvider",
    });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");
    expect(content).toContain("**Reviewer:** mycustomprovider\n");
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

describe("parseDigest", () => {
  it("ignores the 'What got done', 'Issues', and 'Details' multi-section headers", () => {
    // Synthetic digest matching the format writeDigest emits today. The
    // per-cycle section header format is '## <project> — <cycle_id>' (em
    // dash). The summary section headers ('## What got done', '## Issues',
    // '## Details') have no em dash and must not be parsed as cycle rows.
    const markdown = [
      "# GeneralStaff Session Digest",
      "",
      "**Date:** 2026-04-17T09:00:00.000Z",
      "**Duration:** 10m0s",
      "**Cycles:** 1",
      "**Summary:** 1 verified, 0 failed",
      "",
      "## What got done",
      "",
      "1. Some commit subject  _(2 file(s), +10/-3)_",
      "",
      "## Issues",
      "",
      "_None — all cycles passed verification._",
      "",
      "---",
      "",
      "## Details",
      "",
      "_Per-cycle technical detail (SHAs, reviewer verdicts) below._",
      "",
      "## myproj \u2014 cycle-42",
      "",
      "- **Outcome:** verified",
      "- **Reason:** tests pass",
      "- **SHA:** abcdef12 \u2192 12345678",
      "- **Diff:** 2 file(s), +10/-3",
      "- **Engineer exit:** 0",
      "- **Verification:** passed",
      "- **Reviewer:** verified",
      "",
    ].join("\n");

    const parsed = parseDigest(markdown);

    expect(parsed.cycle_count).toBe(1);
    expect(parsed.cycles).toHaveLength(1);
    expect(parsed.cycles[0].project_id).toBe("myproj");
    expect(parsed.cycles[0].cycle_id).toBe("cycle-42");
    expect(parsed.cycles[0].outcome).toBe("verified");
    expect(parsed.cycles[0].reason).toBe("tests pass");
    // No phantom cycles parsed from the summary headers
    const ids = parsed.cycles.map((c) => c.project_id);
    expect(ids).not.toContain("What got done");
    expect(ids).not.toContain("Issues");
    expect(ids).not.toContain("Details");
  });

  it("round-trips a writeDigest output", async () => {
    const results = [
      makeCycleResult({
        project_id: "proj-a",
        cycle_id: "c-1",
        final_outcome: "verified",
        reason: "tests pass, scope matches",
        cycle_start_sha: "aaaaaaaa11111111",
        cycle_end_sha: "bbbbbbbb22222222",
        engineer_exit_code: 0,
        verification_outcome: "passed",
        reviewer_verdict: "verified",
        diff_stats: { files_changed: 1, insertions: 5, deletions: 2 },
      }),
      makeCycleResult({
        project_id: "proj-b",
        cycle_id: "c-2",
        final_outcome: "verification_failed",
        reason: "reviewer rejected scope drift",
        engineer_exit_code: 1,
        verification_outcome: "failed",
        reviewer_verdict: "verification_failed",
      }),
    ];
    await writeDigest(results, 7, { digest_dir: "digests" });

    const digestDir = join(TEST_DIR, "digests");
    const files = readdirSync(digestDir);
    const content = readFileSync(join(digestDir, files[0]), "utf8");
    const parsed = parseDigest(content);

    expect(parsed.cycle_count).toBe(2);
    expect(parsed.cycles).toHaveLength(2);
    expect(parsed.cycles[0].project_id).toBe("proj-a");
    expect(parsed.cycles[0].cycle_id).toBe("c-1");
    expect(parsed.cycles[0].outcome).toBe("verified");
    expect(parsed.cycles[0].sha_start).toBe("aaaaaaaa");
    expect(parsed.cycles[0].sha_end).toBe("bbbbbbbb");
    expect(parsed.cycles[0].diff_stats).toEqual({
      files_changed: 1,
      insertions: 5,
      deletions: 2,
    });
    expect(parsed.cycles[1].project_id).toBe("proj-b");
    expect(parsed.cycles[1].cycle_id).toBe("c-2");
    expect(parsed.cycles[1].outcome).toBe("verification_failed");
    expect(parsed.cycles[1].reason).toBe("reviewer rejected scope drift");
  });

  it("returns an empty cycles array for a digest with zero cycles", () => {
    const markdown = [
      "# GeneralStaff Session Digest",
      "",
      "**Date:** 2026-04-17T09:00:00.000Z",
      "**Duration:** 0m30s",
      "**Cycles:** 0",
      "",
    ].join("\n");

    const parsed = parseDigest(markdown);

    expect(parsed.cycle_count).toBe(0);
    expect(parsed.cycles).toHaveLength(0);
    expect(parsed.duration).toBe("0m30s");
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

  it("stops at max-cycles when maxCycles hits before budget", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_max_cycles.ts",
      "max-cycles-hits-first",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.execute_cycle_calls).toBe(2);
    expect(result.result_count).toBe(2);
    expect(String(result.captured)).toContain("Max-cycles limit reached (2)");
    expect(String(result.captured)).toContain("Stop reason: max-cycles");
  }, 30_000);

  it("stops on budget when budget hits before max-cycles", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_max_cycles.ts",
      "budget-hits-first",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.execute_cycle_calls).toBe(0);
    expect(String(result.captured)).toContain("Stop reason: insufficient-budget");
  }, 30_000);

  it("runs without maxCycles when flag is not supplied", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_max_cycles.ts",
      "default",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(String(result.captured)).not.toContain("Max cycles:");
    expect(String(result.captured)).toContain("Stop reason:");
  }, 30_000);

  it("emits exactly one fleet-level session_complete event", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_session_complete_event.ts",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.complete_event_count).toBe(1);
    expect(result.fleet_project_id).toBe("_fleet");
    const data = result.event_data as Record<string, unknown>;
    expect(data).toBeTruthy();
    expect(data.total_cycles).toBe(result.execute_cycle_calls);
    expect(data.total_failed).toBe(0);
    expect(typeof data.duration_minutes).toBe("number");
    expect(typeof data.stop_reason).toBe("string");
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

describe("runSession --exclude-project", () => {
  it("excludes a single project from the picker", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_exclude_project.ts",
      "single",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.first_skip_snapshot).toContain("alpha");
    expect(result.picked_ids).not.toContain("alpha");
  }, 30_000);

  it("excludes multiple projects (comma-separated)", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_exclude_project.ts",
      "multiple",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.first_skip_snapshot).toContain("alpha");
    expect(result.first_skip_snapshot).toContain("beta");
    const picked = result.picked_ids as string[];
    expect(picked).not.toContain("alpha");
    expect(picked).not.toContain("beta");
  }, 30_000);

  it("ends with no cycles when every project is excluded", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_exclude_project.ts",
      "all-excluded",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    expect(result.execute_cycle_calls).toBe(0);
  }, 30_000);

  it("warns but does not error on unknown exclude ids", async () => {
    const { exitCode, stdout, stderr, result } = await runHelperSubprocess(
      "verify_exclude_project.ts",
      "unknown-id",
    );
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    expect(result.pass).toBe(true);
    const warns = (result.warn_messages as string[]).join("\n");
    expect(warns).toContain("does-not-exist");
    // session still ran against real projects
    expect((result.picked_ids as string[]).length).toBeGreaterThan(0);
  }, 30_000);
});
