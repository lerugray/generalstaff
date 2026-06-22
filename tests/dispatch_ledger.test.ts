// gs-332 Phase 2: dispatch ledger — dedup by cycle_id, resolved-preservation,
// corrupted-entry filtering, mkdir-on-write.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import {
  readDispatchLedger,
  pendingDispatches,
  updateDispatchLedger,
  type DispatchedCycle,
} from "../src/dispatch_ledger";

describe("readDispatchLedger — never throws", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-disp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty on missing file / bad JSON / wrong shape", () => {
    expect(readDispatchLedger(join(dir, "nope.json"))).toEqual({
      dispatches: [],
    });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    expect(readDispatchLedger(bad).dispatches).toEqual([]);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ dispatches: 7 }));
    expect(readDispatchLedger(wrong).dispatches).toEqual([]);
  });

  it("filters null / non-object entries", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(
      p,
      JSON.stringify({
        dispatches: [{ id: "ok", review_status: "pending" }, null, 3, "x"],
      }),
    );
    const led = readDispatchLedger(p);
    expect(led.dispatches).toHaveLength(1);
    expect(pendingDispatches(led)).toHaveLength(1); // would throw on null pre-filter
  });
});

describe("updateDispatchLedger — dedup by cycle_id + resolved-preservation", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-disp-"));
    path = join(dir, "dispatch-ledger.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cyc = (over: Partial<DispatchedCycle> = {}): DispatchedCycle => ({
    project: "p",
    title: "t",
    branch: "bot/work",
    cycle_id: "cyc-1",
    sha: "abc123",
    live: false,
    status: "verified",
    ...over,
  });

  it("records a dispatched cycle keyed by project::cycle_id", () => {
    expect(updateDispatchLedger(path, [cyc()], "t1")).toBe(1);
    const led = readDispatchLedger(path);
    expect(led.dispatches[0].id).toBe("p::cyc-1");
    expect(led.dispatches[0].branch).toBe("bot/work");
    expect(led.dispatches[0].sha).toBe("abc123");
    expect(led.dispatches[0].review_status).toBe("pending");
  });

  it("skips records with no cycle_id (nothing reviewable)", () => {
    expect(updateDispatchLedger(path, [cyc({ cycle_id: "" })], "t1")).toBe(0);
  });

  it("dedups by cycle_id and refreshes last_seen on a re-seen entry", () => {
    updateDispatchLedger(path, [cyc()], "t1");
    expect(updateDispatchLedger(path, [cyc()], "t2")).toBe(0);
    const led = readDispatchLedger(path);
    expect(led.dispatches).toHaveLength(1);
    expect(led.dispatches[0].first_seen).toBe("t1");
    expect(led.dispatches[0].last_seen).toBe("t2");
  });

  it("distinct cycle_ids on the same branch are distinct entries", () => {
    updateDispatchLedger(path, [cyc({ cycle_id: "cyc-1" })], "t1");
    updateDispatchLedger(path, [cyc({ cycle_id: "cyc-2" })], "t2");
    expect(readDispatchLedger(path).dispatches).toHaveLength(2);
  });

  it("preserves a resolved entry across runs", () => {
    updateDispatchLedger(path, [cyc()], "t1");
    const led = readDispatchLedger(path);
    led.dispatches[0].review_status = "resolved";
    led.dispatches[0].resolution = "merged";
    writeFileSync(path, JSON.stringify(led));
    expect(updateDispatchLedger(path, [cyc()], "t3")).toBe(0);
    const after = readDispatchLedger(path);
    expect(after.dispatches[0].review_status).toBe("resolved");
    expect(pendingDispatches(after)).toHaveLength(0);
  });

  it("creates the state dir if missing", () => {
    const nested = join(dir, "a", "b", "dispatch-ledger.json");
    expect(updateDispatchLedger(nested, [cyc()], "t1")).toBe(1);
    expect(existsSync(nested)).toBe(true);
  });
});
