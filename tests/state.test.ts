import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  setRootDir,
  loadFleetState,
  saveFleetState,
  getProjectFleetState,
  updateProjectFleetState,
  withFleetStateTransaction,
  loadProjectState,
  saveProjectState,
  ensureCycleDir,
  writeCycleFile,
  readCycleFile,
  writeStateFile,
  readStateFile,
  getProjectSummary,
  getRecentCycles,
  botWorktreePath,
} from "../src/state";
import type { ProjectConfig } from "../src/types";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from "fs";

const TEST_DIR = join(import.meta.dir, "fixtures", "state_test");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("fleet state", () => {
  it("cleans up a partially written temp and preserves the previous fleet file", async () => {
    if (process.platform === "win32") return; // POSIX file-size limit fixture
    await saveFleetState({ version: 1, updated_at: "", projects: {} });
    const original = readFileSync(join(TEST_DIR, "fleet_state.json"), "utf8");
    const helper = join(import.meta.dir, "helpers", "verify_atomic_write_partial_failure.ts");
    const result = Bun.spawnSync([
      "bash", "-c", 'ulimit -f 1; exec "$1" "$2" "$3"',
      "bash", process.execPath, helper, TEST_DIR,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("EFBIG");
    expect(readFileSync(join(TEST_DIR, "fleet_state.json"), "utf8")).toBe(original);
    expect(readdirSync(TEST_DIR)).toEqual(["fleet_state.json"]);
  });

  it("captures an absolute transaction destination when the root is relative", async () => {
    const originalCwd = process.cwd();
    const other = join(TEST_DIR, "other");
    mkdirSync(join(TEST_DIR, "relative"), { recursive: true });
    mkdirSync(join(other, "relative"), { recursive: true });
    try {
      process.chdir(TEST_DIR);
      setRootDir("relative");
      const update = withFleetStateTransaction((fleet) => {
        updateProjectFleetState(fleet, "captured", "verified", 1);
      });
      process.chdir(other);
      await update;
      expect(existsSync(join(TEST_DIR, "relative", "fleet_state.json"))).toBe(true);
      expect(existsSync(join(other, "relative", "fleet_state.json"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      setRootDir(TEST_DIR);
    }
  });

  it("returns default state when no file exists", async () => {
    const state = await loadFleetState();
    expect(state.version).toBe(1);
    expect(Object.keys(state.projects)).toHaveLength(0);
  });

  it("round-trips save/load", async () => {
    const state = await loadFleetState();
    updateProjectFleetState(state, "test-project", "verified", 15);
    await saveFleetState(state);

    const loaded = await loadFleetState();
    expect(loaded.projects["test-project"]).toBeDefined();
    expect(loaded.projects["test-project"].total_cycles).toBe(1);
    expect(loaded.projects["test-project"].total_verified).toBe(1);
    expect(loaded.projects["test-project"].total_failed).toBe(0);
    expect(loaded.projects["test-project"].accumulated_minutes).toBe(15);
  });

  it("increments counters correctly", async () => {
    const state = await loadFleetState();
    updateProjectFleetState(state, "p", "verified", 10);
    updateProjectFleetState(state, "p", "verification_failed", 5);
    updateProjectFleetState(state, "p", "verified_weak", 8);

    expect(state.projects["p"].total_cycles).toBe(3);
    expect(state.projects["p"].total_verified).toBe(2); // verified + verified_weak
    expect(state.projects["p"].total_failed).toBe(1);
    expect(state.projects["p"].accumulated_minutes).toBe(23);
  });
});

describe("project state", () => {
  it("returns default state when no file exists", async () => {
    const state = await loadProjectState("new-project");
    expect(state.project_id).toBe("new-project");
    expect(state.current_cycle_id).toBeNull();
    expect(state.cycles_this_session).toBe(0);
  });

  it("round-trips save/load", async () => {
    const state = await loadProjectState("my-proj");
    state.last_cycle_id = "cycle-001";
    state.last_cycle_outcome = "verified";
    state.cycles_this_session = 2;
    await saveProjectState(state);

    const loaded = await loadProjectState("my-proj");
    expect(loaded.last_cycle_id).toBe("cycle-001");
    expect(loaded.last_cycle_outcome).toBe("verified");
    expect(loaded.cycles_this_session).toBe(2);
  });
});

describe("cycle files", () => {
  it("creates cycle directory", () => {
    const dir = ensureCycleDir("proj", "cycle-123");
    expect(existsSync(dir)).toBe(true);
  });

  it("writes and reads cycle files", async () => {
    await writeCycleFile("proj", "c1", "test.txt", "hello world");
    const content = await readCycleFile("proj", "c1", "test.txt");
    expect(content).toBe("hello world");
  });

  it("returns null for missing cycle files", async () => {
    const content = await readCycleFile("proj", "c-missing", "nope.txt");
    expect(content).toBeNull();
  });
});

describe("atomic write safety", () => {
  it("rapid sequential writes always produce valid JSON", async () => {
    // Rapid sequential writes to the same file — each must leave
    // valid, parseable JSON on disk (the point of write-tmp-then-rename).
    const N = 20;
    for (let i = 0; i < N; i++) {
      const state = {
        project_id: "rapid-proj",
        current_cycle_id: `cycle-${i}`,
        last_cycle_id: null as null,
        last_cycle_outcome: null as null,
        last_cycle_at: null as null,
        cycles_this_session: i,
      };
      await saveProjectState(state);

      // After every write, the file must be valid JSON with correct data
      const loaded = await loadProjectState("rapid-proj");
      expect(loaded.project_id).toBe("rapid-proj");
      expect(loaded.cycles_this_session).toBe(i);
      expect(loaded.current_cycle_id).toBe(`cycle-${i}`);
    }
  });

  it("no .tmp file left after successful write", async () => {
    const state = await loadProjectState("clean-proj");
    state.last_cycle_id = "c-1";
    await saveProjectState(state);

    const tmpPath = join(TEST_DIR, "state", "clean-proj", "STATE.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);

    // The real file should exist
    const realPath = join(TEST_DIR, "state", "clean-proj", "STATE.json");
    expect(existsSync(realPath)).toBe(true);
  });

  it("concurrent writes to different projects don't interfere", async () => {
    // Parallel writes to separate project state files — no contention
    // on the same .tmp path, but exercises the mkdir + write + rename
    // pipeline under concurrency.
    const N = 10;
    const writes = Array.from({ length: N }, (_, i) => {
      const state = {
        project_id: `para-proj-${i}`,
        current_cycle_id: `cycle-${i}`,
        last_cycle_id: null as null,
        last_cycle_outcome: null as null,
        last_cycle_at: null as null,
        cycles_this_session: i,
      };
      return saveProjectState(state);
    });

    await Promise.all(writes);

    // Each project's file must be independently valid
    for (let i = 0; i < N; i++) {
      const loaded = await loadProjectState(`para-proj-${i}`);
      expect(loaded.project_id).toBe(`para-proj-${i}`);
      expect(loaded.cycles_this_session).toBe(i);
    }
  });

  it("fleet state survives rapid overwrites", async () => {
    const N = 10;
    for (let i = 0; i < N; i++) {
      const state = {
        version: 1 as const,
        updated_at: new Date().toISOString(),
        projects: {
          [`proj-${i}`]: {
            last_cycle_at: null,
            last_cycle_outcome: null as null,
            total_cycles: i,
            total_verified: 0,
            total_failed: 0,
            accumulated_minutes: 0,
          },
        },
      };
      await saveFleetState(state);

      const loaded = await loadFleetState();
      expect(loaded.version).toBe(1);
      const keys = Object.keys(loaded.projects);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe(`proj-${i}`);
      expect(loaded.projects[`proj-${i}`].total_cycles).toBe(i);
    }
  });

  it("writeStateFile uses atomic write (no partial content)", async () => {
    // Write a large payload to verify the tmp-then-rename pattern
    // delivers complete content even for bigger files.
    const payload = JSON.stringify({ data: "x".repeat(10_000) });
    await writeStateFile("atomic-proj", "big.json", payload);

    const read = await readStateFile("atomic-proj", "big.json");
    expect(read).toBe(payload);

    // No tmp file left behind
    const tmpPath = join(TEST_DIR, "state", "atomic-proj", "big.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("overwrite preserves structure after content change", async () => {
    // Write initial state, verify it, then overwrite with different data.
    // The file must reflect only the second write — no bleed-through.
    const state1 = {
      project_id: "overwrite-proj",
      current_cycle_id: "first",
      last_cycle_id: null as null,
      last_cycle_outcome: null as null,
      last_cycle_at: null as null,
      cycles_this_session: 100,
    };
    await saveProjectState(state1);

    // Verify first write landed
    const check1 = await loadProjectState("overwrite-proj");
    expect(check1.current_cycle_id).toBe("first");

    const state2 = {
      ...state1,
      current_cycle_id: "second",
      cycles_this_session: 200,
    };
    await saveProjectState(state2);

    const loaded = await loadProjectState("overwrite-proj");
    expect(loaded.current_cycle_id).toBe("second");
    expect(loaded.cycles_this_session).toBe(200);
  });
});

describe("getProjectSummary", () => {
  function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
    return {
      id: "summary-proj",
      path: TEST_DIR,
      priority: 2,
      engineer_command: "echo engineer",
      verification_command: "echo verify",
      cycle_budget_minutes: 15,
      work_detection: "tasks_json",
      concurrency_detection: "none",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
      ...overrides,
    };
  }

  it("returns defaults when no state files exist", async () => {
    const project = makeProject();
    const fleet = await loadFleetState();

    const summary = await getProjectSummary(project, fleet);
    expect(summary.id).toBe("summary-proj");
    expect(summary.priority).toBe(2);
    expect(summary.state).toBeNull();
    expect(summary.project_state.project_id).toBe("summary-proj");
    expect(summary.project_state.cycles_this_session).toBe(0);
    expect(summary.remaining_tasks).toBe(0);
    expect(summary.recent_cycles).toEqual([]);
  });

  it("aggregates fleet state, project state, and remaining tasks", async () => {
    const project = makeProject({ id: "agg-proj", priority: 1 });

    const fleet = await loadFleetState();
    updateProjectFleetState(fleet, "agg-proj", "verified", 12);
    updateProjectFleetState(fleet, "agg-proj", "verification_failed", 5);
    await saveFleetState(fleet);

    await saveProjectState({
      project_id: "agg-proj",
      current_cycle_id: null,
      last_cycle_id: "cycle-xyz",
      last_cycle_outcome: "verification_failed",
      last_cycle_at: "2026-04-16T00:00:00.000Z",
      cycles_this_session: 3,
    });

    const tasksDir = join(TEST_DIR, "state", "agg-proj");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, "tasks.json"),
      JSON.stringify([
        { id: "t1", status: "pending", priority: 1, title: "a" },
        { id: "t2", status: "done", priority: 2, title: "b" },
        { id: "t3", status: "pending", priority: 3, title: "c" },
        { id: "t4", status: "skipped", priority: 4, title: "d" },
      ]),
    );

    const reloadedFleet = await loadFleetState();
    const summary = await getProjectSummary(project, reloadedFleet);

    expect(summary.id).toBe("agg-proj");
    expect(summary.priority).toBe(1);
    expect(summary.state).not.toBeNull();
    expect(summary.state?.total_cycles).toBe(2);
    expect(summary.state?.total_verified).toBe(1);
    expect(summary.state?.total_failed).toBe(1);
    expect(summary.project_state.last_cycle_id).toBe("cycle-xyz");
    expect(summary.project_state.cycles_this_session).toBe(3);
    expect(summary.remaining_tasks).toBe(2);
  });

  it("includes recent cycles from PROGRESS.jsonl", async () => {
    const project = makeProject({ id: "recent-proj" });
    const projectDir = join(TEST_DIR, "state", "recent-proj");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      makeCycleEnd("c-1", "2026-04-10T00:00:00.000Z", "verified", 30, "abc1234", "def5678"),
      makeCycleEnd("c-2", "2026-04-11T00:00:00.000Z", "verification_failed", 12, "def5678", "aaa0000"),
    ];
    writeFileSync(join(projectDir, "PROGRESS.jsonl"), lines.join("\n") + "\n");

    const fleet = await loadFleetState();
    const summary = await getProjectSummary(project, fleet);
    expect(summary.recent_cycles).toHaveLength(2);
    expect(summary.recent_cycles[0].cycle_id).toBe("c-2");
    expect(summary.recent_cycles[0].outcome).toBe("verification_failed");
    expect(summary.recent_cycles[1].cycle_id).toBe("c-1");
  });
});

function makeCycleEnd(
  cycleId: string,
  timestamp: string,
  outcome: string,
  durationSeconds: number,
  startSha: string,
  endSha: string,
): string {
  return JSON.stringify({
    timestamp,
    event: "cycle_end",
    cycle_id: cycleId,
    project_id: "recent-proj",
    data: {
      outcome,
      duration_seconds: durationSeconds,
      start_sha: startSha,
      end_sha: endSha,
      reason: "",
    },
  });
}

describe("getRecentCycles", () => {
  it("returns empty array when PROGRESS.jsonl is missing", async () => {
    const result = await getRecentCycles("missing-proj", 5);
    expect(result).toEqual([]);
  });

  it("returns at most N cycle_end entries, newest first", async () => {
    const projectDir = join(TEST_DIR, "state", "rc-proj");
    mkdirSync(projectDir, { recursive: true });
    const entries = [
      { cycle_id: "c-1", ts: "2026-04-10T00:00:00.000Z", outcome: "verified" },
      { cycle_id: "c-2", ts: "2026-04-11T00:00:00.000Z", outcome: "verified_weak" },
      { cycle_id: "c-3", ts: "2026-04-12T00:00:00.000Z", outcome: "verification_failed" },
      { cycle_id: "c-4", ts: "2026-04-13T00:00:00.000Z", outcome: "verified" },
    ];
    const lines = entries.map((e) =>
      JSON.stringify({
        timestamp: e.ts,
        event: "cycle_end",
        cycle_id: e.cycle_id,
        project_id: "rc-proj",
        data: { outcome: e.outcome, duration_seconds: 60, start_sha: "a".repeat(40), end_sha: "b".repeat(40) },
      }),
    );
    writeFileSync(join(projectDir, "PROGRESS.jsonl"), lines.join("\n") + "\n");

    const result = await getRecentCycles("rc-proj", 2);
    expect(result).toHaveLength(2);
    expect(result[0].cycle_id).toBe("c-4");
    expect(result[1].cycle_id).toBe("c-3");
    expect(result[0].duration_seconds).toBe(60);
    expect(result[0].outcome).toBe("verified");
  });

  it("skips non-cycle_end events", async () => {
    const projectDir = join(TEST_DIR, "state", "filter-proj");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ timestamp: "2026-04-10T00:00:00.000Z", event: "cycle_start", cycle_id: "c-1", data: {} }),
      JSON.stringify({ timestamp: "2026-04-10T00:01:00.000Z", event: "reviewer_invoked", cycle_id: "c-1", data: {} }),
      JSON.stringify({ timestamp: "2026-04-10T00:02:00.000Z", event: "cycle_end", cycle_id: "c-1", data: { outcome: "verified" } }),
    ];
    writeFileSync(join(projectDir, "PROGRESS.jsonl"), lines.join("\n") + "\n");

    const result = await getRecentCycles("filter-proj", 10);
    expect(result).toHaveLength(1);
    expect(result[0].cycle_id).toBe("c-1");
    expect(result[0].outcome).toBe("verified");
  });

  it("skips malformed JSON lines", async () => {
    const projectDir = join(TEST_DIR, "state", "bad-proj");
    mkdirSync(projectDir, { recursive: true });
    const good = JSON.stringify({
      timestamp: "2026-04-10T00:00:00.000Z",
      event: "cycle_end",
      cycle_id: "c-good",
      data: { outcome: "verified" },
    });
    writeFileSync(
      join(projectDir, "PROGRESS.jsonl"),
      `not-json\n${good}\n{broken`,
    );

    const result = await getRecentCycles("bad-proj", 5);
    expect(result).toHaveLength(1);
    expect(result[0].cycle_id).toBe("c-good");
  });

  it("returns empty when n is 0 or negative", async () => {
    const projectDir = join(TEST_DIR, "state", "zero-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "PROGRESS.jsonl"),
      JSON.stringify({
        timestamp: "2026-04-10T00:00:00.000Z",
        event: "cycle_end",
        cycle_id: "c-x",
        data: { outcome: "verified" },
      }) + "\n",
    );

    expect(await getRecentCycles("zero-proj", 0)).toEqual([]);
    expect(await getRecentCycles("zero-proj", -1)).toEqual([]);
  });
});

describe("botWorktreePath", () => {
  it("returns '<project.path>/.bot-worktree'", () => {
    const project: ProjectConfig = {
      id: "demo",
      path: "/some/project",
      priority: 1,
      engineer_command: "true",
      verification_command: "true",
      cycle_budget_minutes: 1,
      work_detection: "tasks_json",
      concurrency_detection: "worktree",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
    };
    expect(botWorktreePath(project)).toBe(join("/some/project", ".bot-worktree"));
  });

  it("preserves the caller's path verbatim (no normalization)", () => {
    const project: ProjectConfig = {
      id: "rel",
      path: "./relative/path",
      priority: 1,
      engineer_command: "true",
      verification_command: "true",
      cycle_budget_minutes: 1,
      work_detection: "tasks_json",
      concurrency_detection: "worktree",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
    };
    expect(botWorktreePath(project)).toBe(join("./relative/path", ".bot-worktree"));
  });
});

describe("fleet concurrent persistence (reliability)", () => {
  it("independent fresh defaults do not share projects maps", async () => {
    const a = await loadFleetState();
    const b = await loadFleetState();
    expect(a.projects).not.toBe(b.projects);
    a.projects["only-a"] = {
      last_cycle_at: null,
      last_cycle_outcome: null,
      total_cycles: 1,
      total_verified: 0,
      total_failed: 0,
      accumulated_minutes: 0,
    };
    expect(b.projects["only-a"]).toBeUndefined();
    expect(Object.keys(b.projects)).toHaveLength(0);
  });

  it("concurrent transactions for different projects keep both counters", async () => {
    const baseline = await loadFleetState();
    await saveFleetState(baseline);

    await Promise.all([
      withFleetStateTransaction((fleet) => {
        updateProjectFleetState(fleet, "project-a", "verified", 3);
      }),
      withFleetStateTransaction((fleet) => {
        updateProjectFleetState(fleet, "project-b", "verified", 5);
      }),
    ]);

    const loaded = await loadFleetState();
    expect(loaded.projects["project-a"]?.total_cycles).toBe(1);
    expect(loaded.projects["project-a"]?.accumulated_minutes).toBe(3);
    expect(loaded.projects["project-b"]?.total_cycles).toBe(1);
    expect(loaded.projects["project-b"]?.accumulated_minutes).toBe(5);
  });

  it("concurrent same-project increments serialize to the sum", async () => {
    await saveFleetState(await loadFleetState());

    await Promise.all([
      withFleetStateTransaction((fleet) => {
        updateProjectFleetState(fleet, "shared", "verified", 1);
      }),
      withFleetStateTransaction((fleet) => {
        updateProjectFleetState(fleet, "shared", "verified", 1);
      }),
      withFleetStateTransaction((fleet) => {
        updateProjectFleetState(fleet, "shared", "verification_failed", 1);
      }),
    ]);

    const loaded = await loadFleetState();
    expect(loaded.projects["shared"].total_cycles).toBe(3);
    expect(loaded.projects["shared"].total_verified).toBe(2);
    expect(loaded.projects["shared"].total_failed).toBe(1);
    expect(loaded.projects["shared"].accumulated_minutes).toBe(3);
  });

  it("transaction failure releases the lock for subsequent updates", async () => {
    await saveFleetState(await loadFleetState());

    let failed = false;
    try {
      await withFleetStateTransaction((_fleet) => {
        throw new Error("inject-fail");
      });
    } catch (err) {
      failed = err instanceof Error && err.message === "inject-fail";
    }
    expect(failed).toBe(true);

    await withFleetStateTransaction((fleet) => {
      updateProjectFleetState(fleet, "after-fail", "verified", 2);
    });
    const loaded = await loadFleetState();
    expect(loaded.projects["after-fail"]?.total_cycles).toBe(1);
  });

  it("queued transaction keeps the resolved path captured at enqueue", async () => {
    const rootA = join(TEST_DIR, "root-a");
    const rootB = join(TEST_DIR, "root-b");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });

    setRootDir(rootA);
    await saveFleetState(await loadFleetState());

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let firstEntered = false;

    const first = withFleetStateTransaction(async (fleet) => {
      firstEntered = true;
      await firstGate;
      updateProjectFleetState(fleet, "in-a", "verified", 1);
    });

    for (let i = 0; i < 50 && !firstEntered; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(firstEntered).toBe(true);

    // Enqueue while first still holds the lock, then flip root — second
    // must still write to rootA (path captured at invocation).
    const second = withFleetStateTransaction((fleet) => {
      updateProjectFleetState(fleet, "also-a", "verified", 1);
    });
    setRootDir(rootB);

    releaseFirst();
    await Promise.all([first, second]);

    setRootDir(rootA);
    const loadedA = await loadFleetState();
    expect(loadedA.projects["in-a"]?.total_cycles).toBe(1);
    expect(loadedA.projects["also-a"]?.total_cycles).toBe(1);

    setRootDir(rootB);
    const loadedB = await loadFleetState();
    expect(loadedB.projects["in-a"]).toBeUndefined();
    expect(loadedB.projects["also-a"]).toBeUndefined();

    setRootDir(TEST_DIR);
  });
});

describe("atomicWrite (exclusive temp + same-directory rename)", () => {
  const tmpEntries = () => readdirSync(TEST_DIR).filter((n) => n.includes(".tmp"));

  it("continues a queued write after a partial-write failure", async () => {
    if (process.platform === "win32") return; // POSIX file-size limit fixture
    await writeStateFile("queued", "state.txt", "original");
    // Exercise the real writer in an isolated process: the first write
    // exceeds its file-size limit after creating a temp, while the second
    // is already queued for the same destination and fits within the limit.
    const fixture = `
      import { setRootDir, writeStateFile } from ${JSON.stringify(join(import.meta.dir, "../src/state.ts"))};
      process.on("SIGXFSZ", () => {});
      setRootDir(${JSON.stringify(TEST_DIR)});
      const results = await Promise.allSettled([
        writeStateFile("queued", "state.txt", "x".repeat(100_000)),
        writeStateFile("queued", "state.txt", "recovered"),
      ]);
      console.log(JSON.stringify(results.map((result) => ({
        status: result.status,
        code: result.status === "rejected" ? result.reason.code : null,
      }))));
    `;
    const result = Bun.spawnSync([
      "bash", "-c", 'ulimit -f 1; exec "$1" -e "$2"',
      "bash", process.execPath, fixture,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      { status: "rejected", code: "EFBIG" },
      { status: "fulfilled", code: null },
    ]);
    expect(await readStateFile("queued", "state.txt")).toBe("recovered");
    expect(readdirSync(join(TEST_DIR, "state", "queued"))).toEqual(["state.txt"]);
  });

  it("captures absolute destinations before queued writes wait", async () => {
    const originalCwd = process.cwd();
    const other = join(TEST_DIR, "other");
    mkdirSync(other, { recursive: true });
    try {
      process.chdir(TEST_DIR);
      setRootDir("relative");
      const first = writeStateFile("queued", "state.txt", "first");
      setRootDir(join("relative", "unused", ".."));
      const second = writeStateFile("queued", "state.txt", "second");
      process.chdir(other);
      await Promise.all([first, second]);
      expect(readFileSync(join(TEST_DIR, "relative", "state", "queued", "state.txt"), "utf8")).toBe("second");
      expect(existsSync(join(other, "relative"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      setRootDir(TEST_DIR);
    }
  });

  it("leaves no temp files after concurrent fleet saves and the result parses", async () => {
    const base = await loadFleetState();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        saveFleetState({
          ...base,
          projects: {
            [`p${i}`]: {
              last_cycle_at: null,
              last_cycle_outcome: null,
              total_cycles: i,
              total_verified: 0,
              total_failed: 0,
              accumulated_minutes: 0,
            },
          },
        }),
      ),
    );
    expect(tmpEntries()).toEqual([]);
    const parsed = JSON.parse(readFileSync(join(TEST_DIR, "fleet_state.json"), "utf8"));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.projects)).toHaveLength(1);
  });

  it("removes its temp file when the final rename fails", async () => {
    // A directory at the destination makes rename(2) fail with EISDIR.
    mkdirSync(join(TEST_DIR, "fleet_state.json"), { recursive: true });
    let caught: unknown = null;
    try {
      await saveFleetState({ version: 1, updated_at: new Date().toISOString(), projects: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(tmpEntries()).toEqual([]);
  });
});
