import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { catalogdnaHasMoreWork, greenfieldHasMoreWork } from "../src/work_detection";
import { setRootDir } from "../src/state";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

const FIXTURES = join(import.meta.dir, "fixtures", "work_detection");

function writeFixture(relativePath: string, content: string) {
  const fullPath = join(FIXTURES, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  setRootDir(FIXTURES);
});

afterEach(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

describe("catalogdnaHasMoreWork", () => {
  it("returns true when P0-P3 have unchecked items", async () => {
    const projectPath = join(FIXTURES, "project-a");
    writeFixture(
      "project-a/bot_tasks.md",
      `# Bot Tasks — Run 23

## P0 — Critical bugs
- [ ] Fix the login crash
- [x] Handle null pointer

## P1 — High priority
- [x] Add caching

## Phase A — self-directed
- [ ] This should not count
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(true);
  });

  it("returns false when all P0-P3 items are checked", async () => {
    const projectPath = join(FIXTURES, "project-b");
    writeFixture(
      "project-b/bot_tasks.md",
      `# Bot Tasks

## P0 — Critical
- [x] All done

## P1 — High
- [x] Also done
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(false);
  });

  it("skips COMPLETED sections", async () => {
    const projectPath = join(FIXTURES, "project-c");
    writeFixture(
      "project-c/bot_tasks.md",
      `# Bot Tasks

## P0 — COMPLETED INTERACTIVELY — SKIP
- [ ] This unchecked item should be ignored

## P1 — High
- [x] Done
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(false);
  });

  it("returns false when bot_tasks.md doesn't exist", async () => {
    expect(await catalogdnaHasMoreWork(join(FIXTURES, "nonexistent"))).toBe(
      false,
    );
  });

  it("ignores Phase A/B sections", async () => {
    const projectPath = join(FIXTURES, "project-d");
    writeFixture(
      "project-d/bot_tasks.md",
      `# Bot Tasks

## Phase A — Self-directed
- [ ] Explore codebase
- [ ] Refactor utils

## Phase B — Stretch
- [ ] Add metrics
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(false);
  });
});

describe("greenfieldHasMoreWork", () => {
  it("returns true when tasks.json has pending items", async () => {
    writeFixture(
      "state/greenfield/tasks.json",
      JSON.stringify([
        { id: "1", title: "Task 1", status: "done", priority: 1 },
        { id: "2", title: "Task 2", status: "pending", priority: 2 },
      ]),
    );
    expect(await greenfieldHasMoreWork("greenfield")).toBe(true);
  });

  it("returns false when all tasks are done", async () => {
    writeFixture(
      "state/all-done/tasks.json",
      JSON.stringify([
        { id: "1", title: "Task 1", status: "done", priority: 1 },
        { id: "2", title: "Task 2", status: "skipped", priority: 2 },
      ]),
    );
    expect(await greenfieldHasMoreWork("all-done")).toBe(false);
  });

  it("returns true when tasks include in_progress items", async () => {
    writeFixture(
      "state/in-prog/tasks.json",
      JSON.stringify([
        { id: "1", title: "Task 1", status: "done", priority: 1 },
        { id: "2", title: "Task 2", status: "in_progress", priority: 2 },
        { id: "3", title: "Task 3", status: "skipped", priority: 3 },
      ]),
    );
    expect(await greenfieldHasMoreWork("in-prog")).toBe(true);
  });

  it("returns false when tasks.json doesn't exist", async () => {
    expect(await greenfieldHasMoreWork("nonexistent")).toBe(false);
  });
});
