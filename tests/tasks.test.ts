import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { setRootDir } from "../src/state";
import {
  loadTasks,
  pendingTasks,
  deriveTaskIdPrefix,
  nextTaskId,
  addTask,
} from "../src/tasks";
import type { GreenfieldTask } from "../src/types";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    cwd,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("tasks module", () => {
  const TEST_DIR = join(import.meta.dir, "fixtures", "tasks_unit_test");

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "state", "myproj"), { recursive: true });
    setRootDir(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    setRootDir(process.cwd());
  });

  describe("loadTasks", () => {
    it("returns empty array when tasks.json doesn't exist", async () => {
      const tasks = await loadTasks("myproj");
      expect(tasks).toEqual([]);
    });

    it("returns empty array when tasks.json is empty string", async () => {
      writeFileSync(join(TEST_DIR, "state", "myproj", "tasks.json"), "");
      const tasks = await loadTasks("myproj");
      expect(tasks).toEqual([]);
    });

    it("parses a non-empty tasks.json", async () => {
      const data: GreenfieldTask[] = [
        { id: "gs-001", title: "first", status: "pending", priority: 1 },
        { id: "gs-002", title: "second", status: "done", priority: 2 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(data),
      );
      const tasks = await loadTasks("myproj");
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.id).toBe("gs-001");
    });
  });

  describe("pendingTasks", () => {
    it("excludes done and skipped tasks", () => {
      const all: GreenfieldTask[] = [
        { id: "a-1", title: "A", status: "pending", priority: 1 },
        { id: "a-2", title: "B", status: "done", priority: 1 },
        { id: "a-3", title: "C", status: "skipped", priority: 1 },
        { id: "a-4", title: "D", status: "in_progress", priority: 1 },
      ];
      const pending = pendingTasks(all);
      expect(pending.map((t) => t.id)).toEqual(["a-1", "a-4"]);
    });
  });

  describe("deriveTaskIdPrefix", () => {
    it("uses prefix from existing task IDs", () => {
      const existing: GreenfieldTask[] = [
        { id: "gs-001", title: "x", status: "pending", priority: 1 },
      ];
      expect(deriveTaskIdPrefix("generalstaff", existing)).toBe("gs-");
    });

    it("derives from project id when no tasks exist", () => {
      expect(deriveTaskIdPrefix("myproj", [])).toBe("my-");
    });

    it("falls back to 'task-' when project id has no alpha chars", () => {
      expect(deriveTaskIdPrefix("123", [])).toBe("task-");
    });
  });

  describe("nextTaskId", () => {
    it("returns prefix+001 when no existing tasks", () => {
      expect(nextTaskId([], "gs-")).toBe("gs-001");
    });

    it("increments the highest matching numeric suffix", () => {
      const existing: GreenfieldTask[] = [
        { id: "gs-001", title: "x", status: "done", priority: 1 },
        { id: "gs-042", title: "y", status: "pending", priority: 1 },
        { id: "gs-005", title: "z", status: "done", priority: 1 },
      ];
      expect(nextTaskId(existing, "gs-")).toBe("gs-043");
    });

    it("ignores IDs that don't match the prefix", () => {
      const existing: GreenfieldTask[] = [
        { id: "other-999", title: "x", status: "pending", priority: 1 },
      ];
      expect(nextTaskId(existing, "gs-")).toBe("gs-001");
    });

    it("preserves wider zero-padding when existing IDs use more digits", () => {
      const existing: GreenfieldTask[] = [
        { id: "gs-0042", title: "x", status: "pending", priority: 1 },
      ];
      expect(nextTaskId(existing, "gs-")).toBe("gs-0043");
    });
  });

  describe("addTask", () => {
    it("creates tasks.json and appends a new pending task", async () => {
      const task = await addTask("myproj", "do the thing");
      expect(task.id).toBe("my-001");
      expect(task.status).toBe("pending");
      expect(task.priority).toBe(2);

      const path = join(TEST_DIR, "state", "myproj", "tasks.json");
      expect(existsSync(path)).toBe(true);
      const stored = JSON.parse(readFileSync(path, "utf8"));
      expect(stored).toHaveLength(1);
      expect(stored[0].title).toBe("do the thing");
    });

    it("appends to an existing tasks.json and continues the ID sequence", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "first", status: "done", priority: 1 },
        { id: "gs-041", title: "last", status: "done", priority: 2 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed, null, 2),
      );
      const task = await addTask("myproj", "new one", 3);
      expect(task.id).toBe("gs-042");
      expect(task.priority).toBe(3);

      const stored = JSON.parse(
        readFileSync(join(TEST_DIR, "state", "myproj", "tasks.json"), "utf8"),
      );
      expect(stored).toHaveLength(3);
      expect(stored[2].id).toBe("gs-042");
      expect(stored[2].status).toBe("pending");
    });

    it("creates the state dir if it doesn't exist", async () => {
      const task = await addTask("fresh", "brand new");
      expect(task.id).toBe("fr-001");
      const path = join(TEST_DIR, "state", "fresh", "tasks.json");
      expect(existsSync(path)).toBe(true);
    });
  });
});

describe("CLI task command", () => {
  const TEST_DIR = join(import.meta.dir, "fixtures", "tasks_cli_test");

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "state", "proj"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("task list", () => {
    it("errors when --project is missing", async () => {
      const result = await runCli(["task", "list"], TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--project=<id> is required");
    });

    it("prints 'No pending tasks.' when the file is empty", async () => {
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        "[]\n",
      );
      const result = await runCli(
        ["task", "list", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No pending tasks.");
    });

    it("prints only pending/in_progress tasks", async () => {
      const tasks: GreenfieldTask[] = [
        { id: "gs-001", title: "open item", status: "pending", priority: 1 },
        { id: "gs-002", title: "finished", status: "done", priority: 1 },
        { id: "gs-003", title: "discarded", status: "skipped", priority: 2 },
        { id: "gs-004", title: "running", status: "in_progress", priority: 2 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify(tasks),
      );
      const result = await runCli(
        ["task", "list", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("gs-001");
      expect(result.stdout).toContain("open item");
      expect(result.stdout).toContain("gs-004");
      expect(result.stdout).toContain("running");
      expect(result.stdout).not.toContain("gs-002");
      expect(result.stdout).not.toContain("gs-003");
    });
  });

  describe("task add", () => {
    it("errors when --project is missing", async () => {
      const result = await runCli(["task", "add", "some title"], TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--project=<id> is required");
    });

    it("errors when title is missing", async () => {
      const result = await runCli(
        ["task", "add", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task title is required");
    });

    it("appends a new task to tasks.json", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "seeded", status: "done", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify(seed, null, 2),
      );
      const result = await runCli(
        [
          "task",
          "add",
          "--project=proj",
          "--priority=3",
          "Add",
          "a",
          "new",
          "task",
        ],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Added gs-002");

      const stored = JSON.parse(
        readFileSync(join(TEST_DIR, "state", "proj", "tasks.json"), "utf8"),
      );
      expect(stored).toHaveLength(2);
      expect(stored[1].id).toBe("gs-002");
      expect(stored[1].title).toBe("Add a new task");
      expect(stored[1].status).toBe("pending");
      expect(stored[1].priority).toBe(3);
    });
  });

  describe("unknown subcommand", () => {
    it("errors when no subcommand is given", async () => {
      const result = await runCli(["task"], TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task subcommand required");
    });

    it("errors for an unknown subcommand", async () => {
      const result = await runCli(["task", "foo"], TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task subcommand required");
    });
  });

  it("is listed in --help output", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("generalstaff task");
    expect(result.stdout).toContain("task list");
    expect(result.stdout).toContain("task add");
  });
});
