import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  setRootDir,
  loadFleetState,
  saveFleetState,
  getProjectFleetState,
  updateProjectFleetState,
  loadProjectState,
  saveProjectState,
  ensureCycleDir,
  writeCycleFile,
  readCycleFile,
  writeStateFile,
  readStateFile,
} from "../src/state";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

const TEST_DIR = join(import.meta.dir, "fixtures", "state_test");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("fleet state", () => {
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
