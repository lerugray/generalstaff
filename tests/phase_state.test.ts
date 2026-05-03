import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { setRootDir } from "../src/state";
import {
  phaseStatePath,
  loadPhaseState,
  savePhaseState,
  recordPhaseAdvance,
} from "../src/phase_state";

const TEST_DIR = join(process.cwd(), "tmp-test-phase-state");
const PROJECT_ID = "phasestate";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("phaseStatePath", () => {
  it("resolves to state/<project>/PHASE_STATE.json", () => {
    expect(phaseStatePath(PROJECT_ID)).toBe(
      join(TEST_DIR, "state", PROJECT_ID, "PHASE_STATE.json"),
    );
  });
});

describe("loadPhaseState — defaults", () => {
  it("returns in-memory default when file is missing", async () => {
    const state = await loadPhaseState(PROJECT_ID, "mvp");
    expect(state.project_id).toBe(PROJECT_ID);
    expect(state.current_phase).toBe("mvp");
    expect(state.completed_phases).toEqual([]);
    // Default is NOT persisted.
    expect(existsSync(phaseStatePath(PROJECT_ID))).toBe(false);
  });
});

describe("savePhaseState + load round-trip", () => {
  it("persists and re-reads identically", async () => {
    const state = {
      project_id: PROJECT_ID,
      current_phase: "billing",
      completed_phases: [
        {
          phase_id: "mvp",
          completed_at: "2026-05-03T20:00:00.000Z",
          criteria_results: [
            { kind: "all_tasks_done" as const, passed: true, detail: "5/5 done" },
          ],
        },
      ],
    };
    await savePhaseState(state);
    const loaded = await loadPhaseState(PROJECT_ID, "mvp");
    expect(loaded).toEqual(state);
  });

  it("creates the state/<project>/ dir if missing", async () => {
    expect(existsSync(join(TEST_DIR, "state"))).toBe(false);
    await savePhaseState({
      project_id: PROJECT_ID,
      current_phase: "mvp",
      completed_phases: [],
    });
    expect(existsSync(phaseStatePath(PROJECT_ID))).toBe(true);
  });
});

describe("loadPhaseState — validation", () => {
  it("throws on mismatched project_id", async () => {
    mkdirSync(join(TEST_DIR, "state", PROJECT_ID), { recursive: true });
    const path = phaseStatePath(PROJECT_ID);
    const Bun = (globalThis as unknown as { Bun: { write: (p: string, d: string) => Promise<void> } }).Bun;
    await Bun.write(
      path,
      JSON.stringify({ project_id: "wrong", current_phase: "mvp", completed_phases: [] }),
    );
    await expect(loadPhaseState(PROJECT_ID, "mvp")).rejects.toThrow(/does not match registry id/);
  });

  it("throws on malformed JSON", async () => {
    mkdirSync(join(TEST_DIR, "state", PROJECT_ID), { recursive: true });
    const Bun = (globalThis as unknown as { Bun: { write: (p: string, d: string) => Promise<void> } }).Bun;
    await Bun.write(phaseStatePath(PROJECT_ID), "{not valid json");
    await expect(loadPhaseState(PROJECT_ID, "mvp")).rejects.toThrow(/Failed to parse/);
  });
});

describe("recordPhaseAdvance", () => {
  it("appends completed phase + flips current_phase", async () => {
    const updated = await recordPhaseAdvance(PROJECT_ID, "mvp", "billing", [
      { kind: "all_tasks_done", passed: true, detail: "ok" },
    ]);
    expect(updated.current_phase).toBe("billing");
    expect(updated.completed_phases).toHaveLength(1);
    expect(updated.completed_phases[0]!.phase_id).toBe("mvp");
    expect(updated.completed_phases[0]!.criteria_results).toHaveLength(1);
    // ISO 8601 timestamp present
    expect(updated.completed_phases[0]!.completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("preserves prior completed phases when called again", async () => {
    await recordPhaseAdvance(PROJECT_ID, "mvp", "billing", []);
    const updated = await recordPhaseAdvance(PROJECT_ID, "billing", "ads", []);
    expect(updated.completed_phases.map((p) => p.phase_id)).toEqual(["mvp", "billing"]);
    expect(updated.current_phase).toBe("ads");
  });

  it("persists between calls (round-trips through disk)", async () => {
    await recordPhaseAdvance(PROJECT_ID, "mvp", "billing", []);
    const reloaded = await loadPhaseState(PROJECT_ID, "billing");
    expect(reloaded.current_phase).toBe("billing");
    expect(reloaded.completed_phases).toHaveLength(1);
  });
});

describe("PHASE_STATE.json file format", () => {
  it("writes pretty-printed JSON with trailing newline", async () => {
    await savePhaseState({
      project_id: PROJECT_ID,
      current_phase: "mvp",
      completed_phases: [],
    });
    const raw = readFileSync(phaseStatePath(PROJECT_ID), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // Pretty-printed (has indentation)
    expect(raw).toContain('  "project_id"');
  });
});
