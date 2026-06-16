// gs-332: findDoneTaskAcrossLayouts — the worktree-aware markedDone fallback.
// The `task done` CLI writes the worktree's tasks.json (getRootDir()=cwd=the
// worktree), which the committed-diff signal can miss. This helper recovers
// the "marked done" signal by reading the candidate tasks.json copies.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { findDoneTaskAcrossLayouts } from "../src/cycle";

describe("findDoneTaskAcrossLayouts (gs-332)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gs-marked-done-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTasks(name: string, tasks: unknown): string {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(tasks), "utf8");
    return p;
  }

  it("returns a marked-done line when a candidate has the task as done", async () => {
    const p = writeTasks("a/tasks.json", [
      { id: "snake-001", title: "build snake", status: "done" },
    ]);
    const r = await findDoneTaskAcrossLayouts([p], "snake-001");
    expect(r).toContain("snake-001");
    expect(r).toContain("done");
  });

  it("returns null when the task is still pending everywhere", async () => {
    const p = writeTasks("a/tasks.json", [
      { id: "snake-001", title: "build snake", status: "pending" },
    ]);
    expect(await findDoneTaskAcrossLayouts([p], "snake-001")).toBeNull();
  });

  it("checks candidates in order — worktree copy (first) wins", async () => {
    const worktree = writeTasks("worktree/tasks.json", [
      { id: "t1", title: "from worktree", status: "done" },
    ]);
    const main = writeTasks("main/tasks.json", [
      { id: "t1", title: "from main", status: "pending" },
    ]);
    const r = await findDoneTaskAcrossLayouts([worktree, main], "t1");
    expect(r).toContain("from worktree");
  });

  it("skips a missing candidate and finds the task in a later one", async () => {
    const missing = join(dir, "nope/tasks.json");
    const present = writeTasks("b/tasks.json", [
      { id: "t2", title: "found later", status: "done" },
    ]);
    const r = await findDoneTaskAcrossLayouts([missing, present], "t2");
    expect(r).toContain("t2");
  });

  it("ignores a malformed candidate and tries the next", async () => {
    const bad = join(dir, "bad/tasks.json");
    mkdirSync(join(bad, ".."), { recursive: true });
    writeFileSync(bad, "{ not valid json", "utf8");
    const good = writeTasks("good/tasks.json", [
      { id: "t3", title: "ok", status: "done" },
    ]);
    const r = await findDoneTaskAcrossLayouts([bad, good], "t3");
    expect(r).toContain("t3");
  });

  it("returns null when the attempted task id isn't present", async () => {
    const p = writeTasks("a/tasks.json", [
      { id: "other", status: "done" },
    ]);
    expect(await findDoneTaskAcrossLayouts([p], "snake-001")).toBeNull();
  });
});
