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
