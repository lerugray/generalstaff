import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  decideBenchmarkVerdict,
  summarizeBenchmark,
  findPreTaskSha,
  loadTasksJsonAtSha,
  findMissingExpectedTouches,
  runEngineerBenchmark,
  type BenchmarkTaskResult,
} from "../src/benchmark";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
import type { ProjectConfig } from "../src/types";

// --- Pure function tests (no I/O) ---

describe("decideBenchmarkVerdict", () => {
  const baseInput = {
    engineerExitCode: 0,
    engineerTimedOut: false,
    diffFilesChanged: 1,
    verificationExitCode: 0,
  };

  it("returns 'verified' when everything succeeds", () => {
    expect(decideBenchmarkVerdict(baseInput)).toBe("verified");
  });

  it("returns 'engineer_timeout' when engineer timed out, regardless of other fields", () => {
    expect(
      decideBenchmarkVerdict({
        ...baseInput,
        engineerTimedOut: true,
        engineerExitCode: 0,
      }),
    ).toBe("engineer_timeout");
  });

  it("returns 'engineer_failed' when exit code is non-zero", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, engineerExitCode: 1 }),
    ).toBe("engineer_failed");
  });

  it("returns 'engineer_failed' when exit code is null (spawn error)", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, engineerExitCode: null }),
    ).toBe("engineer_failed");
  });

  it("returns 'empty_diff' when engineer succeeded but didn't change anything", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, diffFilesChanged: 0 }),
    ).toBe("empty_diff");
  });

  it("returns 'verification_failed' when engineer+diff OK but verification fails", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, verificationExitCode: 1 }),
    ).toBe("verification_failed");
  });

  it("returns 'verification_failed' when verification exit is null", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, verificationExitCode: null }),
    ).toBe("verification_failed");
  });

  it("engineer_timeout beats engineer_failed (ordering)", () => {
    expect(
      decideBenchmarkVerdict({
        ...baseInput,
        engineerTimedOut: true,
        engineerExitCode: 1,
      }),
    ).toBe("engineer_timeout");
  });

  it("engineer_failed beats empty_diff (ordering)", () => {
    expect(
      decideBenchmarkVerdict({
        ...baseInput,
        engineerExitCode: 1,
        diffFilesChanged: 0,
      }),
    ).toBe("engineer_failed");
  });

  // gs-276: gamed verdict — all signals pass but declared touches missing
  it("returns 'gamed' when everything passes but expected_touches are missing", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, missingExpectedTouches: 1 }),
    ).toBe("gamed");
  });

  it("returns 'verified' when missingExpectedTouches is 0", () => {
    expect(
      decideBenchmarkVerdict({ ...baseInput, missingExpectedTouches: 0 }),
    ).toBe("verified");
  });

  it("returns 'verified' when missingExpectedTouches is omitted (legacy tasks)", () => {
    expect(decideBenchmarkVerdict(baseInput)).toBe("verified");
  });

  it("verification_failed beats gamed (ordering — trust the gate first)", () => {
    expect(
      decideBenchmarkVerdict({
        ...baseInput,
        verificationExitCode: 1,
        missingExpectedTouches: 2,
      }),
    ).toBe("verification_failed");
  });

  it("empty_diff beats gamed (no work at all is worse than gaming)", () => {
    expect(
      decideBenchmarkVerdict({
        ...baseInput,
        diffFilesChanged: 0,
        missingExpectedTouches: 2,
      }),
    ).toBe("empty_diff");
  });
});

describe("findMissingExpectedTouches", () => {
  const FIXTURE = join(tmpdir(), `gs-missing-touches-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(join(FIXTURE, "src"), { recursive: true });
    writeFileSync(join(FIXTURE, "src", "exists.ts"), "export {};\n", "utf8");
  });

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("returns [] when expected_touches is undefined (legacy task)", () => {
    expect(findMissingExpectedTouches(FIXTURE, undefined)).toEqual([]);
  });

  it("returns [] when expected_touches is empty", () => {
    expect(findMissingExpectedTouches(FIXTURE, [])).toEqual([]);
  });

  it("returns [] when every declared path exists", () => {
    expect(
      findMissingExpectedTouches(FIXTURE, ["src/exists.ts"]),
    ).toEqual([]);
  });

  it("returns the subset of paths that don't exist", () => {
    const missing = findMissingExpectedTouches(FIXTURE, [
      "src/exists.ts",
      "src/ghost.ts",
      "tests/ghost.test.ts",
    ]);
    expect(missing).toEqual(["src/ghost.ts", "tests/ghost.test.ts"]);
  });
});

describe("summarizeBenchmark", () => {
  const baseResult: BenchmarkTaskResult = {
    task_id: "t",
    pre_task_sha: "abc",
    verdict: "verified",
    engineer_exit_code: 0,
    engineer_duration_seconds: 10,
    engineer_timed_out: false,
    verification_exit_code: 0,
    verification_duration_seconds: 2,
    diff_files_changed: 1,
    diff_insertions: 5,
    diff_deletions: 1,
  };

  it("returns all zeros for empty task list", () => {
    const s = summarizeBenchmark([]);
    expect(s.total).toBe(0);
    expect(s.verified).toBe(0);
    expect(s.verified_rate).toBe(0);
    expect(s.mean_engineer_duration_seconds).toBe(0);
  });

  it("counts verdicts correctly", () => {
    const tasks: BenchmarkTaskResult[] = [
      { ...baseResult, task_id: "a", verdict: "verified" },
      { ...baseResult, task_id: "b", verdict: "verified" },
      { ...baseResult, task_id: "c", verdict: "verification_failed" },
      { ...baseResult, task_id: "d", verdict: "empty_diff" },
      { ...baseResult, task_id: "e", verdict: "engineer_failed" },
      { ...baseResult, task_id: "f", verdict: "engineer_timeout" },
      { ...baseResult, task_id: "g", verdict: "setup_failed" },
      { ...baseResult, task_id: "h", verdict: "gamed" },
    ];
    const s = summarizeBenchmark(tasks);
    expect(s.total).toBe(8);
    expect(s.verified).toBe(2);
    expect(s.gamed).toBe(1);
    expect(s.verification_failed).toBe(1);
    expect(s.empty_diff).toBe(1);
    expect(s.engineer_failed).toBe(1);
    expect(s.engineer_timeout).toBe(1);
    expect(s.setup_failed).toBe(1);
  });

  it("computes verified_rate as a 0-1 fraction", () => {
    const tasks: BenchmarkTaskResult[] = [
      { ...baseResult, task_id: "a", verdict: "verified" },
      { ...baseResult, task_id: "b", verdict: "verified" },
      { ...baseResult, task_id: "c", verdict: "verified" },
      { ...baseResult, task_id: "d", verdict: "verification_failed" },
      { ...baseResult, task_id: "e", verdict: "verification_failed" },
    ];
    const s = summarizeBenchmark(tasks);
    expect(s.verified_rate).toBeCloseTo(0.6, 5);
  });

  it("computes mean durations", () => {
    const tasks: BenchmarkTaskResult[] = [
      { ...baseResult, engineer_duration_seconds: 10, verification_duration_seconds: 1 },
      { ...baseResult, engineer_duration_seconds: 20, verification_duration_seconds: 3 },
      { ...baseResult, engineer_duration_seconds: 30, verification_duration_seconds: 5 },
    ];
    const s = summarizeBenchmark(tasks);
    expect(s.mean_engineer_duration_seconds).toBe(20);
    expect(s.mean_verification_duration_seconds).toBe(3);
  });
});

// --- Git helper tests (use a temp repo fixture) ---

const FIXTURE_REPO = join(tmpdir(), `gs-benchmark-fixture-${Date.now()}`);

async function setupFixtureRepo() {
  mkdirSync(FIXTURE_REPO, { recursive: true });
  await $`git -C ${FIXTURE_REPO} init --initial-branch=master -q`.quiet();
  await $`git -C ${FIXTURE_REPO} config user.email "test@test.com"`.quiet();
  await $`git -C ${FIXTURE_REPO} config user.name "Test"`.quiet();
  await $`git -C ${FIXTURE_REPO} config commit.gpgsign false`.quiet();

  // Commit 1: initial state (pre-task-001) — tasks.json with task-001 pending
  mkdirSync(join(FIXTURE_REPO, "state", "fixture"), { recursive: true });
  writeFileSync(
    join(FIXTURE_REPO, "state", "fixture", "tasks.json"),
    JSON.stringify(
      [
        { id: "task-001", title: "First task", status: "pending", priority: 1 },
        { id: "task-002", title: "Second task", status: "pending", priority: 1 },
      ],
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await $`git -C ${FIXTURE_REPO} add -A`.quiet();
  await $`git -C ${FIXTURE_REPO} commit -q -m "initial"`.quiet();

  // Commit 2: task-001 completion (subject starts with "task-001:")
  writeFileSync(join(FIXTURE_REPO, "artifact-001.txt"), "work for task 001\n", "utf8");
  writeFileSync(
    join(FIXTURE_REPO, "state", "fixture", "tasks.json"),
    JSON.stringify(
      [
        { id: "task-001", title: "First task", status: "done", priority: 1 },
        { id: "task-002", title: "Second task", status: "pending", priority: 1 },
      ],
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await $`git -C ${FIXTURE_REPO} add -A`.quiet();
  await $`git -C ${FIXTURE_REPO} commit -q -m "task-001: ship first task"`.quiet();

  // Commit 3: task-002 completion (subject starts with "task-002:")
  writeFileSync(join(FIXTURE_REPO, "artifact-002.txt"), "work for task 002\n", "utf8");
  writeFileSync(
    join(FIXTURE_REPO, "state", "fixture", "tasks.json"),
    JSON.stringify(
      [
        { id: "task-001", title: "First task", status: "done", priority: 1 },
        { id: "task-002", title: "Second task", status: "done", priority: 1 },
      ],
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await $`git -C ${FIXTURE_REPO} add -A`.quiet();
  await $`git -C ${FIXTURE_REPO} commit -q -m "task-002: ship second task"`.quiet();
}

describe("findPreTaskSha + loadTasksJsonAtSha (git-backed)", () => {
  beforeAll(async () => {
    await setupFixtureRepo();
  });

  afterAll(() => {
    rmSync(FIXTURE_REPO, { recursive: true, force: true });
  });

  it("finds the parent of a task's completion commit", async () => {
    const sha = await findPreTaskSha(FIXTURE_REPO, "task-001");
    expect(sha).not.toBeNull();
    // Pre-task-001 SHA should resolve to something (the initial commit).
    expect(sha!.length).toBeGreaterThan(10);
  });

  it("returns the task queue as it existed at pre-task SHA", async () => {
    const sha = await findPreTaskSha(FIXTURE_REPO, "task-001");
    const tasks = await loadTasksJsonAtSha(FIXTURE_REPO, "fixture", sha!);
    expect(tasks).toHaveLength(2);
    const task001 = tasks.find((t) => t.id === "task-001");
    expect(task001?.status).toBe("pending");
  });

  it("pre-task-002 sees task-001 as done and task-002 as pending", async () => {
    const sha = await findPreTaskSha(FIXTURE_REPO, "task-002");
    const tasks = await loadTasksJsonAtSha(FIXTURE_REPO, "fixture", sha!);
    const task001 = tasks.find((t) => t.id === "task-001");
    const task002 = tasks.find((t) => t.id === "task-002");
    expect(task001?.status).toBe("done");
    expect(task002?.status).toBe("pending");
  });

  it("returns null when no matching commit exists", async () => {
    const sha = await findPreTaskSha(FIXTURE_REPO, "task-nonexistent");
    expect(sha).toBeNull();
  });

  it("does not match when task id appears in the middle of the subject (anchored)", async () => {
    // The fixture has "task-001: ship first task" — searching for "ship"
    // must not match as if it were a task id.
    const sha = await findPreTaskSha(FIXTURE_REPO, "ship");
    expect(sha).toBeNull();
  });

  it("returns empty array for a bogus project id", async () => {
    const sha = await findPreTaskSha(FIXTURE_REPO, "task-001");
    const tasks = await loadTasksJsonAtSha(FIXTURE_REPO, "no-such-project", sha!);
    expect(tasks).toEqual([]);
  });
});

// --- Integration test (dry-run, no engineer spawn) ---

describe("runEngineerBenchmark dry-run + setup-failure handling", () => {
  const fakeProject: ProjectConfig = {
    id: "fixture",
    path: FIXTURE_REPO,
    priority: 1,
    engineer_command: "echo fake",
    verification_command: "test 1 -eq 1",
    cycle_budget_minutes: 30,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["CLAUDE.md"],
  };

  beforeAll(async () => {
    // Shared fixture with the describe block above — if it hasn't run
    // yet, set it up here too. beforeAll is describe-scoped.
    try {
      await $`git -C ${FIXTURE_REPO} rev-parse HEAD`.quiet();
    } catch {
      await setupFixtureRepo();
    }
  });

  it("dry-run produces a report shape with setup_failed for every task", async () => {
    const report = await runEngineerBenchmark(fakeProject, {
      projectId: "fixture",
      taskIds: ["task-001", "task-002"],
      provider: "aider",
      dryRun: true,
    });

    expect(report.project_id).toBe("fixture");
    expect(report.provider).toBe("aider");
    expect(report.tasks).toHaveLength(2);
    expect(report.tasks.every((t) => t.verdict === "setup_failed")).toBe(true);
    expect(report.summary.total).toBe(2);
    expect(report.summary.setup_failed).toBe(2);
    expect(report.summary.verified_rate).toBe(0);
  });

  it("records error for tasks with no matching commit", async () => {
    const report = await runEngineerBenchmark(fakeProject, {
      projectId: "fixture",
      taskIds: ["task-nonexistent"],
      provider: "aider",
      // Not a dry run — we want the actual setup failure path.
      dryRun: false,
    });

    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0].verdict).toBe("setup_failed");
    expect(report.tasks[0].error).toContain("pre-task SHA");
    expect(report.tasks[0].pre_task_sha).toBeNull();
  });

  it("uses DEFAULT_AIDER_MODEL when engineerModel is unset", async () => {
    const report = await runEngineerBenchmark(fakeProject, {
      projectId: "fixture",
      taskIds: [],
      provider: "aider",
      dryRun: true,
    });
    expect(report.engineer_model).toContain("qwen");
  });

  it("uses the supplied engineerModel override in the report header", async () => {
    const report = await runEngineerBenchmark(fakeProject, {
      projectId: "fixture",
      taskIds: [],
      provider: "aider",
      engineerModel: "openrouter/anthropic/custom-model",
      dryRun: true,
    });
    expect(report.engineer_model).toBe("openrouter/anthropic/custom-model");
  });
});
