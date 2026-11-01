import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { stringify } from "yaml";
import {
  carryPath,
  collectEvents,
  eventsMarkdown,
  expandGlob,
  failureReason,
  isFastFailure,
  readCarry,
  readWatermark,
  writeCarry,
  writeWatermark,
  type Watermark,
} from "../../src/co_seat/events";
import { setRootDir } from "../../src/state";
import { loadCtx, makeSandbox, seatBlock, writeProjectsYaml, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

function progress(root: string, project: string, lines: unknown[], raw = false) {
  const path = join(root, "state", project, "PROGRESS.jsonl");
  mkdirSync(join(root, "state", project), { recursive: true });
  const text = lines.map((l) => (raw ? String(l) : JSON.stringify(l)) + "\n").join("");
  appendFileSync(path, text);
  return path;
}
const cycleEnd = (id: string, outcome = "verified", reason = "") => ({
  timestamp: "2026-11-01T10:00:00.000Z",
  event: "cycle_end",
  project_id: "app",
  cycle_id: id,
  data: { outcome, reason },
});

async function seat(wake: Record<string, unknown> = {}, projects = ["app"], ids = ["app"]) {
  writeProjectsYaml(sb.root, [seatBlock("main", { projects, wake })], ids);
  return loadCtx("main");
}

describe("collectEvents: cycle_end records", () => {
  it("records a baseline on first collection and reports history as nothing new", async () => {
    progress(sb.root, "app", [cycleEnd("old-1"), cycleEnd("old-2")]);
    const ctx = await seat();
    const first = await collectEvents(ctx, null, { firstTurn: true });
    expect(first.hasEvents).toBe(false);
    expect(first.counts).toEqual({ cycles: 0, inbox: 0, sentinels: 0, carried: 0 });
    expect(first.lines.some((l) => l.startsWith("First turn of this seat"))).toBe(true);
    expect(first.newWatermark.progress.app).toBeGreaterThan(0);
    // Nothing new on the next look either.
    const again = await collectEvents(ctx, first.newWatermark);
    expect(again.hasEvents).toBe(false);
  });

  it("reports new cycle_end records only, once", async () => {
    const path = progress(sb.root, "app", [cycleEnd("old")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    appendFileSync(path, JSON.stringify({ ...cycleEnd("x"), event: "cycle_start", data: {} }) + "\n");
    appendFileSync(path, "{this is not json\n");
    appendFileSync(path, JSON.stringify(cycleEnd("new-1", "verified_weak", "empty diff")) + "\n");
    appendFileSync(path, JSON.stringify(cycleEnd("new-2", "verification_failed")) + "\n");
    const got = await collectEvents(ctx, base.newWatermark);
    expect(got.counts.cycles).toBe(2);
    expect(got.hasEvents).toBe(true);
    expect(got.lines).toEqual([
      "cycle ended: app new-1 outcome=verified_weak reason=empty diff",
      "cycle ended: app new-2 outcome=verification_failed",
    ]);
    const next = await collectEvents(ctx, got.newWatermark);
    expect(next.hasEvents).toBe(false);
  });

  it("does not consume a half-written last line, and picks it up when complete", async () => {
    const path = progress(sb.root, "app", [cycleEnd("old")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    const whole = JSON.stringify(cycleEnd("late"));
    appendFileSync(path, whole.slice(0, 20));
    const partial = await collectEvents(ctx, base.newWatermark);
    expect(partial.hasEvents).toBe(false);
    expect(partial.newWatermark.progress.app).toBe(base.newWatermark.progress.app);
    appendFileSync(path, whole.slice(20) + "\n");
    const done = await collectEvents(ctx, partial.newWatermark);
    expect(done.lines).toEqual(["cycle ended: app late outcome=verified"]);
  });

  it("takes the watermark at collection time: a record that lands afterwards is seen next time, once", async () => {
    const path = progress(sb.root, "app", [cycleEnd("old")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    appendFileSync(path, JSON.stringify(cycleEnd("before")) + "\n");
    const collected = await collectEvents(ctx, base.newWatermark);
    expect(collected.lines).toHaveLength(1);
    // The turn is running; another cycle finishes meanwhile.
    appendFileSync(path, JSON.stringify(cycleEnd("during-turn")) + "\n");
    const next = await collectEvents(ctx, collected.newWatermark);
    expect(next.lines).toEqual(["cycle ended: app during-turn outcome=verified"]);
    expect((await collectEvents(ctx, next.newWatermark)).hasEvents).toBe(false);
  });

  it("collecting does not move the persisted watermark: an undelivered event is collected again", async () => {
    const path = progress(sb.root, "app", [cycleEnd("old")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    appendFileSync(path, JSON.stringify(cycleEnd("waiting")) + "\n");
    const a = await collectEvents(ctx, base.newWatermark);
    const b = await collectEvents(ctx, base.newWatermark);
    expect(a.lines).toEqual(b.lines);
  });

  it("restarts from the top when the file shrank", async () => {
    const path = progress(sb.root, "app", [cycleEnd("a"), cycleEnd("b"), cycleEnd("c")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    rmSync(path);
    progress(sb.root, "app", [cycleEnd("fresh")]);
    const got = await collectEvents(ctx, base.newWatermark);
    expect(got.lines).toEqual(["cycle ended: app fresh outcome=verified"]);
  });

  it("only watches the seat's own projects, and wake.cycles can turn it off", async () => {
    const other = join(sb.root, "state", "site");
    mkdirSync(other, { recursive: true });
    const ctx = await seat({}, ["app"], ["app", "site"]);
    const base = await collectEvents(ctx, null);
    writeFileSync(join(other, "PROGRESS.jsonl"), JSON.stringify({ ...cycleEnd("s1"), project_id: "site" }) + "\n");
    expect((await collectEvents(ctx, base.newWatermark)).hasEvents).toBe(false);

    const off = await seat({ cycles: false });
    const baseOff = await collectEvents(off, null);
    progress(sb.root, "app", [cycleEnd("ignored")]);
    expect((await collectEvents(off, baseOff.newWatermark)).hasEvents).toBe(false);
  });

  it("caps each kind of line and says how many more", async () => {
    const path = progress(sb.root, "app", [cycleEnd("old")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    for (let i = 0; i < 5; i++) appendFileSync(path, JSON.stringify(cycleEnd(`n${i}`)) + "\n");
    const got = await collectEvents(ctx, base.newWatermark, { maxLinesPerKind: 2 });
    expect(got.counts.cycles).toBe(5);
    expect(got.lines).toHaveLength(3);
    expect(got.lines[2]).toBe("... and 3 more cycle_end records");
  });
});

function aide(name: string, inbox: string) {
  return {
    name,
    kind: "fictional bot",
    owner: "Example Operator",
    description: "An illustrative Aide",
    door: { type: "file", path: "door.md" },
    inbox,
    capabilities: ["review"],
    credential_scope: "Own review workspace",
    hard_lines: ["Record decisions"],
  };
}
const row = (stamp: string, title: string, tags = "") =>
  `## 2026-11-01 ${stamp} UTC Cinder: ${title}${tags}\n- body line\n\n`;

describe("collectEvents: Aide inbox rows", () => {
  function setup(rowsText: string) {
    writeFileSync(join(sb.root, "aides.yaml"), stringify({ aides: [aide("Cinder", "cinder.md")] }));
    writeFileSync(join(sb.root, "cinder.md"), rowsText);
    writeFileSync(join(sb.root, "door.md"), "");
  }

  it("reports new rows without the outbound tag, and counts both toward the watermark", async () => {
    setup(row("09:00", "old row"));
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    expect(base.newWatermark.inbox.Cinder).toBe(1);
    appendFileSync(join(sb.root, "cinder.md"), row("10:00", "Outbound request", " [outbound]") + row("10:05", "Review done", " [review]"));
    const got = await collectEvents(ctx, base.newWatermark);
    expect(got.counts.inbox).toBe(1);
    expect(got.lines).toEqual(["Aide inbox: Cinder: 2026-11-01 10:05 UTC Cinder: Review done [review]"]);
    expect(got.newWatermark.inbox.Cinder).toBe(3);
    expect((await collectEvents(ctx, got.newWatermark)).hasEvents).toBe(false);
  });

  it("no aides.yaml means no events and no error", async () => {
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    const got = await collectEvents(ctx, base.newWatermark);
    expect(got).toMatchObject({ hasEvents: false, lines: [] });
  });

  it("a broken registry or inbox becomes a note, not a throw, and keeps the old count", async () => {
    setup(row("09:00", "old row"));
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    writeFileSync(join(sb.root, "cinder.md"), "## this heading is not a row heading\n");
    const bad = await collectEvents(ctx, base.newWatermark);
    expect(bad.hasEvents).toBe(false);
    expect(bad.lines.some((l) => l.includes("inbox unreadable"))).toBe(true);
    expect(bad.newWatermark.inbox.Cinder).toBe(1);
    writeFileSync(join(sb.root, "aides.yaml"), "aides: not-a-list\n");
    const noReg = await collectEvents(ctx, base.newWatermark);
    expect(noReg.lines.some((l) => l.includes("Aide registry unreadable"))).toBe(true);
    expect(noReg.newWatermark.inbox.Cinder).toBe(1);
  });

  it("re-baselines, with a note, when an inbox has fewer rows than before", async () => {
    setup(row("09:00", "one") + row("09:05", "two"));
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    expect(base.newWatermark.inbox.Cinder).toBe(2);
    writeFileSync(join(sb.root, "cinder.md"), row("11:00", "after an archive pass"));
    const got = await collectEvents(ctx, base.newWatermark);
    expect(got.hasEvents).toBe(false);
    expect(got.lines.some((l) => l.includes("fewer rows than before"))).toBe(true);
    expect(got.newWatermark.inbox.Cinder).toBe(1);
  });

  it("wake.aide_inboxes can turn it off", async () => {
    setup(row("09:00", "old row"));
    const ctx = await seat({ aide_inboxes: false });
    const base = await collectEvents(ctx, null);
    appendFileSync(join(sb.root, "cinder.md"), row("10:05", "Review done"));
    expect((await collectEvents(ctx, base.newWatermark)).hasEvents).toBe(false);
  });
});

describe("collectEvents: done_globs sentinels", () => {
  it("reports sentinels that are new or changed, relative to the GS root, even above it", async () => {
    const gs = join(sb.root, "gs");
    mkdirSync(gs, { recursive: true });
    setRootDir(gs);
    const lanes = join(sb.root, "lanes");
    mkdirSync(join(lanes, "a"), { recursive: true });
    writeFileSync(join(lanes, "a", "run.done"), "done\n");
    mkdirSync(join(gs, "local"), { recursive: true });
    writeProjectsYaml(gs, [seatBlock("main", { wake: { done_globs: ["../lanes/*/run.done", "local/*.sentinel", "local/literal.txt"] } })]);
    const ctx = await loadCtx("main");

    const base = await collectEvents(ctx, null);
    expect(base.hasEvents).toBe(false);
    expect(Object.keys(base.newWatermark.globs)).toEqual(["../lanes/a/run.done"]);

    mkdirSync(join(lanes, "b"), { recursive: true });
    writeFileSync(join(lanes, "b", "run.done"), "done\n");
    writeFileSync(join(gs, "local", "x.sentinel"), "1");
    writeFileSync(join(gs, "local", "literal.txt"), "1");
    const got = await collectEvents(ctx, base.newWatermark);
    expect(got.lines.sort()).toEqual([
      "done sentinel appeared: ../lanes/b/run.done",
      "done sentinel appeared: local/literal.txt",
      "done sentinel appeared: local/x.sentinel",
    ]);

    expect((await collectEvents(ctx, got.newWatermark)).hasEvents).toBe(false);

    // A rewritten sentinel (different size) is a change.
    writeFileSync(join(lanes, "a", "run.done"), "done again, longer\n");
    const changed = await collectEvents(ctx, got.newWatermark);
    expect(changed.lines).toEqual(["done sentinel changed: ../lanes/a/run.done"]);

    // Deleted then re-created counts as new again.
    rmSync(join(lanes, "b", "run.done"));
    const gone = await collectEvents(ctx, changed.newWatermark);
    expect(gone.hasEvents).toBe(false);
    writeFileSync(join(lanes, "b", "run.done"), "back\n");
    const back = await collectEvents(ctx, gone.newWatermark);
    expect(back.lines).toEqual(["done sentinel appeared: ../lanes/b/run.done"]);
  });

  it("expandGlob returns nothing for a missing base directory", () => {
    expect(expandGlob("nowhere/*/run.done", sb.root)).toEqual([]);
    expect(expandGlob("nowhere/file", sb.root)).toEqual([]);
  });
});

describe("collectEvents: notes", () => {
  it("adds a first-turn note, a heartbeat note, and notes for a killed or restored previous turn", async () => {
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    const w = base.newWatermark;
    expect((await collectEvents(ctx, w)).lines).toEqual([]);

    const hb = await collectEvents(ctx, w, { heartbeat: true });
    expect(hb.lines).toHaveLength(1);
    expect(hb.lines[0]).toContain("Heartbeat");
    expect(hb.hasEvents).toBe(false);

    for (const reason of ["timeout", "stop"]) {
      const killed = await collectEvents(ctx, w, { previous: { n: 4, end_reason: reason, state_restored: false } });
      expect(killed.lines[0]).toContain(`Turn 4 was killed (${reason})`);
      expect(killed.lines[0]).toContain("generalstaff status");
    }
    const exited = await collectEvents(ctx, w, { previous: { n: 4, end_reason: "exit", state_restored: false } });
    expect(exited.lines).toEqual([]);

    const restored = await collectEvents(ctx, w, { previous: { n: 5, end_reason: "exit", state_restored: true } });
    expect(restored.lines[0]).toContain("Turn 5 left the state file without a required heading");
  });

  it("eventsMarkdown", () => {
    expect(eventsMarkdown(3, "2026-11-01T00:00:00.000Z", [])).toContain("- (no new events)");
    expect(eventsMarkdown(3, "2026-11-01T00:00:00.000Z", ["a", "b"])).toContain("- a\n- b\n");
  });
});

describe("watermark file", () => {
  it("round-trips, and a missing or damaged file reads as null", () => {
    const dir = join(sb.root, "seat");
    expect(readWatermark(dir)).toBeNull();
    const wm: Watermark = { version: 1, progress: { app: 12 }, inbox: { Cinder: 2 }, globs: { "a/b": { mtimeMs: 1, size: 2 } } };
    writeWatermark(dir, wm);
    expect(readWatermark(dir)).toEqual(wm);
    writeFileSync(join(dir, "watermark.json"), "nope");
    expect(readWatermark(dir)).toBeNull();
  });
});

describe("fast failures and carried events", () => {
  it("isFastFailure: a spawn error, or a non-zero exit within 60 s; nothing else", () => {
    expect(isFastFailure({ end_reason: "spawn_error" })).toBe(true);
    expect(isFastFailure({ end_reason: "exit", exit_code: 1, duration_ms: 59_999 })).toBe(true);
    expect(isFastFailure({ end_reason: "exit", exit_code: null, duration_ms: 100 })).toBe(true); // killed by a signal
    expect(isFastFailure({ end_reason: "exit", exit_code: 1, duration_ms: 60_000 })).toBe(false);
    expect(isFastFailure({ end_reason: "exit", exit_code: 0, duration_ms: 100 })).toBe(false);
    expect(isFastFailure({ end_reason: "timeout", exit_code: null, duration_ms: 100 })).toBe(false);
    expect(isFastFailure({ end_reason: "stop", exit_code: null, duration_ms: 100 })).toBe(false);
    expect(isFastFailure({ end_reason: "exit", exit_code: 1 })).toBe(false); // no duration recorded
    expect(failureReason({ end_reason: "spawn_error" })).toBe("it could not start");
    expect(failureReason({ end_reason: "exit", exit_code: 2, duration_ms: 5400 })).toBe("exit code 2 after 5 s");
  });

  it("adds a note for a turn that failed fast, the way it does for a killed one", async () => {
    const ctx = await seat();
    const w = (await collectEvents(ctx, null)).newWatermark;
    const fast = await collectEvents(ctx, w, { previous: { n: 3, end_reason: "exit", state_restored: false, exit_code: 2, duration_ms: 5000 } });
    expect(fast.lines).toHaveLength(1);
    expect(fast.lines[0]).toContain("Turn 3 failed fast (exit code 2 after 5 s)");
    expect(fast.lines[0]).toContain("turns/3/run.err");
    const spawn = await collectEvents(ctx, w, { previous: { n: 4, end_reason: "spawn_error", state_restored: false } });
    expect(spawn.lines[0]).toContain("Turn 4 failed fast (it could not start)");
    for (const previous of [
      { n: 5, end_reason: "exit", state_restored: false, exit_code: 0, duration_ms: 1000 },
      { n: 5, end_reason: "exit", state_restored: false, exit_code: 1, duration_ms: 120_000 },
    ]) {
      expect((await collectEvents(ctx, w, { previous })).lines).toEqual([]);
    }
  });

  it("delivers carried events first, labelled, and they count as events by themselves", async () => {
    const path = progress(sb.root, "app", [cycleEnd("old")]);
    const ctx = await seat();
    const base = await collectEvents(ctx, null);
    appendFileSync(path, JSON.stringify(cycleEnd("fresh")) + "\n");
    const carried = [{ from_turn: 3, reason: "exit code 2 after 5 s", line: "cycle ended: app lost-1 outcome=verified" }];
    const got = await collectEvents(ctx, base.newWatermark, { carried });
    expect(got.lines).toEqual([
      "CARRIED FROM TURN 3 (it failed: exit code 2 after 5 s): cycle ended: app lost-1 outcome=verified",
      "cycle ended: app fresh outcome=verified",
    ]);
    expect(got.counts).toMatchObject({ cycles: 1, carried: 1 });
    expect(got.eventLines).toEqual(["cycle ended: app fresh outcome=verified"]);

    const only = await collectEvents(ctx, got.newWatermark, { carried });
    expect(only.hasEvents).toBe(true);
    expect(only.counts).toMatchObject({ cycles: 0, carried: 1 });
    expect((await collectEvents(ctx, got.newWatermark, { carried: [] })).hasEvents).toBe(false);
  });

  it("the carry file round-trips, an empty list removes it, and damage reads as empty", () => {
    const dir = join(sb.root, "seat");
    expect(readCarry(dir)).toEqual([]);
    const entries = [{ from_turn: 2, reason: "it could not start", line: "cycle ended: app c1 outcome=verified" }];
    writeCarry(dir, entries);
    expect(readCarry(dir)).toEqual(entries);
    writeCarry(dir, []);
    expect(existsSync(carryPath(dir))).toBe(false);
    writeFileSync(join(dir, "carry.json"), "{nope");
    expect(readCarry(dir)).toEqual([]);
    writeFileSync(join(dir, "carry.json"), JSON.stringify({ entries: [{ line: 1 }, entries[0]] }));
    expect(readCarry(dir)).toEqual(entries);
  });
});
