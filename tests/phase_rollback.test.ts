// Tests for the phase_state.recordPhaseRollback helper added in
// Phase B+ (2026-05-04). The CLI wrapper in src/cli.ts adds the
// audit-event emission + sentinel-clear; the core rollback logic
// lives in phase_state.ts and is exercised here.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { setRootDir } from "../src/state";
import {
  recordPhaseAdvance,
  recordPhaseRollback,
  loadPhaseState,
} from "../src/phase_state";

const TEST_DIR = join(process.cwd(), "tmp-test-phase-rollback");
const PROJECT_ID = "rollproj";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "state", PROJECT_ID), { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("recordPhaseRollback — basic", () => {
  it("rolls back one phase: launch -> mvp", async () => {
    // Build state: advanced mvp -> launch
    await recordPhaseAdvance(PROJECT_ID, "mvp", "launch", []);

    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "mvp");
    expect(result.from_phase).toBe("launch");
    expect(result.to_phase).toBe("mvp");
    expect(result.undone_phases).toEqual(["mvp"]);
    expect(result.forced).toBe(false);

    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.current_phase).toBe("mvp");
    expect(state.completed_phases).toHaveLength(0);
  });

  it("rolls back through multiple phases: live -> launch -> mvp", async () => {
    // Build state: mvp -> launch -> live
    await recordPhaseAdvance(PROJECT_ID, "mvp", "launch", []);
    await recordPhaseAdvance(PROJECT_ID, "launch", "live", []);

    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "mvp");
    expect(result.from_phase).toBe("live");
    expect(result.to_phase).toBe("mvp");
    // Both launch and mvp pop off (target itself also gets re-opened)
    expect(result.undone_phases).toEqual(["launch", "mvp"]);

    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.current_phase).toBe("mvp");
    expect(state.completed_phases).toHaveLength(0);
  });

  it("rolls back partway: live -> launch (keeps mvp completed)", async () => {
    await recordPhaseAdvance(PROJECT_ID, "mvp", "launch", []);
    await recordPhaseAdvance(PROJECT_ID, "launch", "live", []);

    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "launch");
    expect(result.from_phase).toBe("live");
    expect(result.to_phase).toBe("launch");
    expect(result.undone_phases).toEqual(["launch"]);

    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.current_phase).toBe("launch");
    expect(state.completed_phases).toHaveLength(1);
    expect(state.completed_phases[0]!.phase_id).toBe("mvp");
  });

  it("no-op when target equals current phase", async () => {
    await recordPhaseAdvance(PROJECT_ID, "mvp", "launch", []);

    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "launch");
    expect(result.from_phase).toBe("launch");
    expect(result.to_phase).toBe("launch");
    expect(result.undone_phases).toEqual([]);

    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.current_phase).toBe("launch");
    expect(state.completed_phases).toHaveLength(1);
  });
});

describe("recordPhaseRollback — error paths", () => {
  it("throws when target is not in completed_phases (without --force)", async () => {
    await recordPhaseAdvance(PROJECT_ID, "mvp", "launch", []);

    await expect(
      recordPhaseRollback(PROJECT_ID, "mvp", "ghost"),
    ).rejects.toThrow(/not in completed_phases/);
  });

  it("forced rollback to never-visited phase sets current_phase directly", async () => {
    await recordPhaseAdvance(PROJECT_ID, "mvp", "launch", []);

    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "ghost", {
      forced: true,
    });
    expect(result.from_phase).toBe("launch");
    expect(result.to_phase).toBe("ghost");
    expect(result.undone_phases).toEqual([]);
    expect(result.forced).toBe(true);

    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.current_phase).toBe("ghost");
    // completed_phases unchanged — forced bypass doesn't pop history
    expect(state.completed_phases).toHaveLength(1);
    expect(state.completed_phases[0]!.phase_id).toBe("mvp");
  });
});

describe("recordPhaseRollback — fresh project (no PHASE_STATE.json yet)", () => {
  it("forced rollback works even when PHASE_STATE.json has never been written", async () => {
    // No prior advance — PHASE_STATE.json doesn't exist. Default
    // current_phase comes from the roadmap argument.
    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "ghost", {
      forced: true,
    });
    expect(result.from_phase).toBe("mvp");
    expect(result.to_phase).toBe("ghost");
    expect(result.forced).toBe(true);
  });

  it("non-forced rollback to current phase is a no-op even when fresh", async () => {
    const result = await recordPhaseRollback(PROJECT_ID, "mvp", "mvp");
    expect(result.from_phase).toBe("mvp");
    expect(result.to_phase).toBe("mvp");
    expect(result.undone_phases).toEqual([]);
  });
});
