// gs-332 Phase 2: the dispatch TARGETING guarantee + cap/candidate logic.
//
// dispatchItem adds a synthetic task then excludes every pre-existing task so
// the cycle can ONLY pick the synthetic one. This asserts that exact mechanism
// against the real picker (nextBotPickableTask), so the guarantee can't silently
// regress. The full execute path (real cycle + ledger) is exercised by the live
// e2e; this locks the deterministic core.

import { describe, expect, it } from "bun:test";
import { nextBotPickableTask } from "../src/tasks";
import {
  resolveDispatchCap,
  resolveLiveDispatchCap,
  dispatchRecordFromResult,
  DEFAULT_DISPATCH_CAP,
  DEFAULT_LIVE_DISPATCH_CAP,
} from "../src/autonomous_session";
import type {
  GreenfieldTask,
  ProjectsYaml,
  ProjectConfig,
  CycleResult,
} from "../src/types";

const task = (id: string, over: Partial<GreenfieldTask> = {}): GreenfieldTask => ({
  id,
  title: `task ${id}`,
  status: "pending",
  priority: 2,
  ...over,
});

describe("dispatch targeting — exclude-set guarantees the synthetic task is picked", () => {
  it("with every pre-existing id excluded, only the synthetic task is pickable", () => {
    // Pre-existing pending tasks (could be picked by a normal session).
    const existing = [task("t-001"), task("t-002", { priority: 1 })];
    const excludeIds = new Set(existing.map((t) => t.id));
    // The synthetic task added by dispatchItem (fresh id, NOT in the set).
    const synthetic = task("auto-003", { priority: 1 });
    const all = [...existing, synthetic];

    const picked = nextBotPickableTask(all, [], undefined, excludeIds);
    expect(picked?.id).toBe("auto-003");
  });

  it("even a higher-priority pre-existing task can't be picked when excluded", () => {
    const existing = [task("t-001", { priority: 0 })]; // top priority
    const excludeIds = new Set(existing.map((t) => t.id));
    const synthetic = task("auto-002", { priority: 5 }); // low priority
    const picked = nextBotPickableTask(
      [...existing, synthetic],
      [],
      undefined,
      excludeIds,
    );
    expect(picked?.id).toBe("auto-002"); // excluded t-001 loses despite priority 0
  });

  it("without exclusion the pre-existing task would win — proving the guard is load-bearing", () => {
    const existing = [task("t-001", { priority: 0 })];
    const synthetic = task("auto-002", { priority: 5 });
    const picked = nextBotPickableTask([...existing, synthetic], [], undefined);
    expect(picked?.id).toBe("t-001"); // no exclude set → priority wins
  });
});

describe("dispatchRecordFromResult — only reviewable work is recorded", () => {
  const project = { id: "p", branch: "bot/work" } as ProjectConfig;
  const res = (over: Partial<CycleResult>): CycleResult =>
    ({
      cycle_id: "cyc-1",
      project_id: "p",
      started_at: "",
      ended_at: "",
      cycle_start_sha: "aaa",
      cycle_end_sha: "bbb",
      engineer_exit_code: 0,
      verification_outcome: "passed",
      reviewer_verdict: "verified",
      final_outcome: "verified",
      reason: "",
      ...over,
    }) as CycleResult;

  it("records a verified cycle whose branch moved (the positive path)", () => {
    const rec = dispatchRecordFromResult(res({}), project, "do a thing", false);
    expect(rec).not.toBeNull();
    expect(rec!.project).toBe("p");
    expect(rec!.branch).toBe("bot/work");
    expect(rec!.cycle_id).toBe("cyc-1");
    expect(rec!.sha).toBe("bbb");
    expect(rec!.status).toBe("verified");
    expect(rec!.live).toBe(false);
  });

  it("records a verified_weak cycle that moved, carrying the live flag", () => {
    const rec = dispatchRecordFromResult(
      res({ final_outcome: "verified_weak" }),
      project,
      "t",
      true,
    );
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("verified_weak");
    expect(rec!.live).toBe(true);
  });

  it("returns null on an empty diff (start SHA == end SHA) — no-op engineer", () => {
    expect(
      dispatchRecordFromResult(
        res({ final_outcome: "verified_weak", cycle_start_sha: "x", cycle_end_sha: "x" }),
        project,
        "t",
        false,
      ),
    ).toBeNull();
  });

  it("returns null on verification_failed (rolled back — nothing to review)", () => {
    expect(
      dispatchRecordFromResult(
        res({ final_outcome: "verification_failed" }),
        project,
        "t",
        false,
      ),
    ).toBeNull();
  });

  it("returns null on cycle_skipped / skipped SHAs", () => {
    expect(
      dispatchRecordFromResult(
        res({ final_outcome: "cycle_skipped", cycle_start_sha: "skipped", cycle_end_sha: "skipped" }),
        project,
        "t",
        false,
      ),
    ).toBeNull();
  });
});

describe("dispatch cap resolution", () => {
  const cfg = (over: Partial<ProjectsYaml["dispatcher"]> = {}): ProjectsYaml =>
    ({ projects: [], dispatcher: over }) as unknown as ProjectsYaml;

  it("falls back to built-in defaults", () => {
    expect(resolveDispatchCap(cfg())).toBe(DEFAULT_DISPATCH_CAP);
    expect(resolveLiveDispatchCap(cfg())).toBe(DEFAULT_LIVE_DISPATCH_CAP);
  });

  it("honors dispatcher.autonomous overrides", () => {
    expect(
      resolveDispatchCap(cfg({ autonomous: { dispatch_cap: 5 } })),
    ).toBe(5);
    expect(
      resolveLiveDispatchCap(cfg({ autonomous: { live_dispatch_cap: 3 } })),
    ).toBe(3);
  });
});
