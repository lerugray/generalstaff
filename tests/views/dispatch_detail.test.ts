import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setRootDir } from "../../src/state";
import {
  getDispatchDetail,
  DispatchDetailError,
} from "../../src/views/dispatch_detail";

const FIXTURE_DIR = join(tmpdir(), `gs-dispatch-detail-${process.pid}`);

function writeFleetLog(events: Array<Record<string, unknown>>): void {
  const dir = join(FIXTURE_DIR, "state", "_fleet");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  writeFileSync(join(dir, "PROGRESS.jsonl"), lines.join("\n") + "\n");
}

function writeProjectsYaml(
  projects: Array<{ id: string; path: string }>,
): void {
  const yaml = [
    "projects:",
    ...projects.flatMap((p) => [
      `  - id: ${p.id}`,
      `    path: ${p.path.replace(/\\/g, "/")}`,
      `    priority: 1`,
      `    engineer_command: "echo"`,
      `    verification_command: "echo"`,
      `    cycle_budget_minutes: 30`,
      `    branch: bot/work`,
      `    auto_merge: false`,
      `    hands_off:`,
      `      - secret/`,
    ]),
    "dispatcher:",
    "  max_parallel_slots: 1",
  ].join("\n");
  writeFileSync(join(FIXTURE_DIR, "projects.yaml"), yaml, "utf8");
}

function writeProjectTasks(
  projectId: string,
  tasks: Array<Record<string, unknown>>,
): string {
  const dir = join(FIXTURE_DIR, `proj-${projectId}`);
  const stateDir = join(dir, "state", projectId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "tasks.json"), JSON.stringify(tasks, null, 2));
  return dir;
}

function cycleStart(
  cycleId: string,
  ts: string,
  extra: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "cycle_start",
    cycle_id: cycleId,
    project_id: "generalstaff",
    ...extra,
    data: {
      session_id: "sess-x",
      task_id: "gs-100",
      sha_before: "aaa111",
      ...data,
    },
  };
}

function cycleEnd(
  cycleId: string,
  ts: string,
  outcome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "cycle_end",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: "sess-x",
      outcome,
      verdict_prose: "looks good",
      duration_seconds: 240,
      sha_after: "bbb222",
      files_touched: [
        { path: "src/foo.ts", added: 30, removed: 2 },
        { path: "tests/foo.test.ts", added: 80, removed: 0 },
      ],
      diff_stats: { additions: 110, deletions: 2 },
      ...extra,
    },
  };
}

function engineerInvoked(
  cycleId: string,
  ts: string,
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "engineer_invoked",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: "sess-x",
      command: "bash scripts/run_bot.sh ${cycle_budget_minutes}",
    },
  };
}

function engineerCompleted(
  cycleId: string,
  ts: string,
  durationSeconds: number,
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "engineer_completed",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: "sess-x",
      exit_code: 0,
      duration_seconds: durationSeconds,
    },
  };
}

function verificationRun(
  cycleId: string,
  ts: string,
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "verification_run",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: "sess-x",
      command: "bun test && bun x tsc --noEmit",
    },
  };
}

function verificationOutcome(
  cycleId: string,
  ts: string,
  outcome: string,
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "verification_outcome",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: { session_id: "sess-x", outcome },
  };
}

function reviewerInvoked(
  cycleId: string,
  ts: string,
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "reviewer_invoked",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: { session_id: "sess-x", prompt_length: 4197 },
  };
}

function reviewerVerdict(
  cycleId: string,
  ts: string,
  verdict: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    event: "reviewer_verdict",
    cycle_id: cycleId,
    project_id: "generalstaff",
    data: {
      session_id: "sess-x",
      verdict,
      reason: "ok",
      scope_drift_files: [],
      hands_off_violations: [],
      silent_failures: [],
      ...extra,
    },
  };
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("getDispatchDetail", () => {
  it("verified cycle: builds full DispatchDetailData with all phases populated", async () => {
    const projDir = writeProjectTasks("generalstaff", [
      {
        id: "gs-100",
        title: "Add the widget",
        status: "done",
        priority: 1,
      },
    ]);
    writeProjectsYaml([{ id: "generalstaff", path: projDir }]);

    writeFleetLog([
      cycleStart("c1", "2026-04-18T21:27:05Z"),
      engineerInvoked("c1", "2026-04-18T21:27:05.421Z"),
      engineerCompleted("c1", "2026-04-18T21:35:22.175Z", 497),
      verificationRun("c1", "2026-04-18T21:35:23Z"),
      verificationOutcome("c1", "2026-04-18T21:36:31Z", "passed"),
      reviewerInvoked("c1", "2026-04-18T21:36:32Z"),
      reviewerVerdict("c1", "2026-04-18T21:36:38Z", "verified"),
      cycleEnd("c1", "2026-04-18T21:36:38.500Z", "verified"),
    ]);

    const data = await getDispatchDetail("c1");
    expect(data.cycle_id).toBe("c1");
    expect(data.task_id).toBe("gs-100");
    expect(data.task_title).toBe("Add the widget");
    expect(data.project_id).toBe("generalstaff");
    expect(data.session_id).toBe("sess-x");
    expect(data.verdict).toBe("verified");
    expect(data.verdict_prose).toBe("looks good");
    expect(data.duration_seconds).toBe(240);
    expect(data.sha_before).toBe("aaa111");
    expect(data.sha_after).toBe("bbb222");
    expect(data.files_touched).toHaveLength(2);
    expect(data.files_touched[0]).toEqual({
      path: "src/foo.ts",
      added: 30,
      removed: 2,
    });
    expect(data.diff_added).toBe(110);
    expect(data.diff_removed).toBe(2);
    expect(data.engineer.started_at).toBe("2026-04-18T21:27:05.421Z");
    expect(data.engineer.ended_at).toBe("2026-04-18T21:35:22.175Z");
    expect(data.engineer.duration_seconds).toBe(497);
    expect(data.engineer.detail).toContain("scripts/run_bot.sh");
    expect(data.verification.started_at).toBe("2026-04-18T21:35:23Z");
    expect(data.verification.ended_at).toBe("2026-04-18T21:36:31Z");
    expect(data.verification.detail).toBe("passed");
    expect(data.review.started_at).toBe("2026-04-18T21:36:32Z");
    expect(data.review.ended_at).toBe("2026-04-18T21:36:38Z");
    expect(data.review.detail).toBe("verified");
    expect(data.checks).toHaveLength(3);
    expect(data.checks.every((c) => c.passed)).toBe(true);
  });

  it("failed cycle: verdict='failed' with verdict_prose and check details", async () => {
    writeProjectsYaml([
      { id: "generalstaff", path: writeProjectTasks("generalstaff", []) },
    ]);
    writeFleetLog([
      cycleStart("c2", "2026-04-18T22:00:00Z"),
      reviewerVerdict("c2", "2026-04-18T22:05:00Z", "verification_failed", {
        scope_drift_files: ["src/safety.ts"],
        hands_off_violations: ["src/prompts/foo.md"],
        silent_failures: [],
      }),
      cycleEnd("c2", "2026-04-18T22:05:01Z", "verification_failed", {
        verdict_prose: "scope drift into safety.ts",
      }),
    ]);

    const data = await getDispatchDetail("c2");
    expect(data.verdict).toBe("failed");
    expect(data.verdict_prose).toBe("scope drift into safety.ts");
    expect(data.checks).toHaveLength(3);
    const byName = Object.fromEntries(data.checks.map((c) => [c.name, c]));
    expect(byName.scope.passed).toBe(false);
    expect(byName.scope.detail).toContain("src/safety.ts");
    expect(byName.hands_off.passed).toBe(false);
    expect(byName.silent_failures.passed).toBe(true);
  });

  it("unknown cycle_id throws DispatchDetailError", async () => {
    writeProjectsYaml([
      { id: "generalstaff", path: writeProjectTasks("generalstaff", []) },
    ]);
    writeFleetLog([cycleStart("c-real", "2026-04-18T10:00:00Z")]);

    await expect(getDispatchDetail("c-missing")).rejects.toThrow(
      DispatchDetailError,
    );
    await expect(getDispatchDetail("c-missing")).rejects.toThrow(
      "cycle not found: c-missing",
    );
  });

  it("missing PROGRESS.jsonl throws DispatchDetailError", async () => {
    writeProjectsYaml([
      { id: "generalstaff", path: writeProjectTasks("generalstaff", []) },
    ]);
    await expect(getDispatchDetail("anything")).rejects.toThrow(
      DispatchDetailError,
    );
  });

  it("sequential-mode: events in per-project PROGRESS.jsonl resolve when fleet log is missing the cycle", async () => {
    // Regression test for the 2026-04-20 /cycle/:id 404 bug. Sequential-mode
    // sessions (max_parallel_slots=1) emit cycle events ONLY to
    // state/<project>/PROGRESS.jsonl. The previous getDispatchDetail only
    // read state/_fleet/PROGRESS.jsonl, so every sequential-mode cycle
    // drill-down in the /cycle/:id route returned 404.
    const projDir = writeProjectTasks("generalstaff", [
      { id: "gs-100", title: "seq-only task", status: "done", priority: 1 },
    ]);
    writeProjectsYaml([{ id: "generalstaff", path: projDir }]);

    // Fleet log present but cycle not in it (matches real sequential-mode).
    writeFleetLog([
      {
        timestamp: "2026-04-20T10:00:00Z",
        event: "session_complete",
        project_id: "_fleet",
        data: { duration_minutes: 5 },
      },
    ]);

    // Cycle events live in state/generalstaff/PROGRESS.jsonl only.
    const projStateDir = join(FIXTURE_DIR, "state", "generalstaff");
    mkdirSync(projStateDir, { recursive: true });
    const events = [
      cycleStart("seq-c1", "2026-04-20T10:30:00Z"),
      engineerInvoked("seq-c1", "2026-04-20T10:30:01Z"),
      engineerCompleted("seq-c1", "2026-04-20T10:35:00Z", 299),
      verificationRun("seq-c1", "2026-04-20T10:35:01Z"),
      verificationOutcome("seq-c1", "2026-04-20T10:36:00Z", "passed"),
      reviewerInvoked("seq-c1", "2026-04-20T10:36:01Z"),
      reviewerVerdict("seq-c1", "2026-04-20T10:36:05Z", "verified"),
      cycleEnd("seq-c1", "2026-04-20T10:36:05.500Z", "verified"),
    ];
    writeFileSync(
      join(projStateDir, "PROGRESS.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const data = await getDispatchDetail("seq-c1");
    expect(data.cycle_id).toBe("seq-c1");
    expect(data.verdict).toBe("verified");
    expect(data.project_id).toBe("generalstaff");
    expect(data.task_id).toBe("gs-100");
    expect(data.task_title).toBe("seq-only task");
    expect(data.engineer.duration_seconds).toBe(299);
  });

  it("cycle with null task_id returns task_title: null without throwing", async () => {
    writeProjectsYaml([
      { id: "generalstaff", path: writeProjectTasks("generalstaff", []) },
    ]);
    writeFleetLog([
      cycleStart("c3", "2026-04-18T10:00:00Z", {}, { task_id: null }),
      cycleEnd("c3", "2026-04-18T10:01:00Z", "verified", { task_id: null }),
    ]);

    const data = await getDispatchDetail("c3");
    expect(data.task_id).toBeNull();
    expect(data.task_title).toBeNull();
  });

  it("cycle whose task entry was deleted from tasks.json returns task_title: null", async () => {
    writeProjectsYaml([
      {
        id: "generalstaff",
        path: writeProjectTasks("generalstaff", [
          { id: "gs-other", title: "Different task", status: "done", priority: 1 },
        ]),
      },
    ]);
    writeFleetLog([
      cycleStart("c4", "2026-04-18T10:00:00Z", {}, { task_id: "gs-deleted" }),
      cycleEnd("c4", "2026-04-18T10:01:00Z", "verified", {
        task_id: "gs-deleted",
      }),
    ]);

    const data = await getDispatchDetail("c4");
    expect(data.task_id).toBe("gs-deleted");
    expect(data.task_title).toBeNull();
  });

  it("cycle with no reviewer check data returns checks: []", async () => {
    writeProjectsYaml([
      { id: "generalstaff", path: writeProjectTasks("generalstaff", []) },
    ]);
    writeFleetLog([
      cycleStart("c5", "2026-04-18T10:00:00Z"),
      // reviewer_verdict with NO scope/hands_off/silent fields
      {
        timestamp: "2026-04-18T10:01:00Z",
        event: "reviewer_verdict",
        cycle_id: "c5",
        project_id: "generalstaff",
        data: { session_id: "sess-x", verdict: "verified", reason: "ok" },
      },
      cycleEnd("c5", "2026-04-18T10:01:30Z", "verified"),
    ]);

    const data = await getDispatchDetail("c5");
    expect(data.checks).toEqual([]);
  });

  it("phase timing math: duration_seconds computed from end - start when not provided", async () => {
    writeProjectsYaml([
      { id: "generalstaff", path: writeProjectTasks("generalstaff", []) },
    ]);
    writeFleetLog([
      cycleStart("c6", "2026-04-18T10:00:00Z"),
      // engineer_invoked with no duration_seconds reported on completion
      engineerInvoked("c6", "2026-04-18T10:00:10Z"),
      {
        timestamp: "2026-04-18T10:02:10Z",
        event: "engineer_completed",
        cycle_id: "c6",
        project_id: "generalstaff",
        data: { session_id: "sess-x", exit_code: 0 },
      },
      // cycle_end without duration_seconds — should be computed from
      // start/end timestamps.
      {
        timestamp: "2026-04-18T10:02:30Z",
        event: "cycle_end",
        cycle_id: "c6",
        project_id: "generalstaff",
        data: {
          session_id: "sess-x",
          outcome: "verified",
          verdict_prose: null,
          sha_after: "ccc333",
        },
      },
    ]);

    const data = await getDispatchDetail("c6");
    expect(data.engineer.duration_seconds).toBe(120);
    expect(data.duration_seconds).toBe(150);
  });
});
