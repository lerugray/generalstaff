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
  markTaskDone,
  markTaskPending,
  countTasks,
  TasksLoadError,
  TaskValidationError,
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

    it("throws TasksLoadError with file path on malformed JSON", async () => {
      const path = join(TEST_DIR, "state", "myproj", "tasks.json");
      writeFileSync(path, "{not valid json");
      let caught: unknown;
      try {
        await loadTasks("myproj");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TasksLoadError);
      const err = caught as TasksLoadError;
      expect(err.filePath).toBe(path);
      expect(err.message).toContain("invalid JSON");
      expect(err.message).toContain("tasks.json");
    });

    it("throws TasksLoadError when JSON is valid but not an array", async () => {
      const path = join(TEST_DIR, "state", "myproj", "tasks.json");
      writeFileSync(path, JSON.stringify({ id: "x", title: "y" }));
      let caught: unknown;
      try {
        await loadTasks("myproj");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TasksLoadError);
      const err = caught as TasksLoadError;
      expect(err.filePath).toBe(path);
      expect(err.message).toContain("expected a JSON array");
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

    it("rejects an empty title with TaskValidationError", async () => {
      await expect(addTask("myproj", "")).rejects.toBeInstanceOf(
        TaskValidationError,
      );
      const path = join(TEST_DIR, "state", "myproj", "tasks.json");
      expect(existsSync(path)).toBe(false);
    });

    it("rejects a whitespace-only title with TaskValidationError", async () => {
      await expect(addTask("myproj", "   \t  \n")).rejects.toMatchObject({
        name: "TaskValidationError",
        message: "task title cannot be empty",
      });
    });

    it("trims surrounding whitespace from a valid title", async () => {
      const task = await addTask("myproj", "  padded title  ");
      expect(task.title).toBe("padded title");
    });

    it("accepts a very long title (>500 chars) at the library layer", async () => {
      const long = "x".repeat(600);
      const task = await addTask("myproj", long);
      expect(task.title).toBe(long);
      expect(task.title.length).toBe(600);
    });
  });

  describe("countTasks", () => {
    it("returns zeros for an empty list", () => {
      expect(countTasks([])).toEqual({ pending: 0, done: 0, total: 0 });
    });

    it("counts pending, done, and total; skipped adds only to total", () => {
      const tasks: GreenfieldTask[] = [
        { id: "a-1", title: "A", status: "pending", priority: 1 },
        { id: "a-2", title: "B", status: "pending", priority: 1 },
        { id: "a-3", title: "C", status: "in_progress", priority: 1 },
        { id: "a-4", title: "D", status: "done", priority: 1 },
        { id: "a-5", title: "E", status: "done", priority: 1 },
        { id: "a-6", title: "F", status: "skipped", priority: 1 },
      ];
      expect(countTasks(tasks)).toEqual({ pending: 3, done: 2, total: 6 });
    });
  });

  describe("markTaskDone", () => {
    it("returns project_not_found when tasks.json is missing", async () => {
      const result = await markTaskDone("nope", "x-1");
      expect(result.kind).toBe("project_not_found");
    });

    it("returns task_not_found when id isn't present", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "pending", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await markTaskDone("myproj", "gs-999");
      expect(result.kind).toBe("task_not_found");
      if (result.kind === "task_not_found") {
        expect(result.availableIds).toEqual(["gs-001"]);
      }
    });

    it("returns already_done when task is already done", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "done", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await markTaskDone("myproj", "gs-001");
      expect(result.kind).toBe("already_done");
    });

    it("marks a pending task as done and persists", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "pending", priority: 1 },
        { id: "gs-002", title: "b", status: "pending", priority: 2 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed, null, 2),
      );
      const result = await markTaskDone("myproj", "gs-002");
      expect(result.kind).toBe("done");

      const stored = JSON.parse(
        readFileSync(join(TEST_DIR, "state", "myproj", "tasks.json"), "utf8"),
      );
      expect(stored[1].status).toBe("done");
      expect(stored[0].status).toBe("pending");
    });
  });

  describe("markTaskPending", () => {
    it("returns project_not_found when tasks.json is missing", async () => {
      const result = await markTaskPending("nope", "x-1");
      expect(result.kind).toBe("project_not_found");
    });

    it("returns task_not_found when id isn't present", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "done", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await markTaskPending("myproj", "gs-999");
      expect(result.kind).toBe("task_not_found");
      if (result.kind === "task_not_found") {
        expect(result.availableIds).toEqual(["gs-001"]);
      }
    });

    it("returns already_pending when task is already pending", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "pending", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await markTaskPending("myproj", "gs-001");
      expect(result.kind).toBe("already_pending");
    });

    it("reopens a done task as pending and persists", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "done", priority: 1 },
        { id: "gs-002", title: "b", status: "done", priority: 2 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "myproj", "tasks.json"),
        JSON.stringify(seed, null, 2),
      );
      const result = await markTaskPending("myproj", "gs-002");
      expect(result.kind).toBe("reopened");

      const stored = JSON.parse(
        readFileSync(join(TEST_DIR, "state", "myproj", "tasks.json"), "utf8"),
      );
      expect(stored[1].status).toBe("pending");
      expect(stored[0].status).toBe("done");
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

    it("surfaces a clear error when tasks.json is malformed", async () => {
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        "{not valid json",
      );
      const result = await runCli(
        ["task", "list", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Failed to load tasks");
      expect(result.stderr).toContain("invalid JSON");
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
      expect(result.stderr).toContain("task title cannot be empty");
    });

    it("errors when title is an empty string", async () => {
      const result = await runCli(
        ["task", "add", "--project=proj", ""],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task title cannot be empty");
    });

    it("errors when title is whitespace-only", async () => {
      const result = await runCli(
        ["task", "add", "--project=proj", "   "],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task title cannot be empty");
    });

    it("warns but still adds when title exceeds 500 characters", async () => {
      const long = "x".repeat(600);
      const result = await runCli(
        ["task", "add", "--project=proj", long],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("600 characters");
      expect(result.stderr).toContain("over 500");
      expect(result.stdout).toContain("Added ");
      const stored = JSON.parse(
        readFileSync(join(TEST_DIR, "state", "proj", "tasks.json"), "utf8"),
      );
      expect(stored[stored.length - 1].title.length).toBe(600);
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

  describe("task done", () => {
    it("errors when --project is missing", async () => {
      const result = await runCli(["task", "done", "--task=gs-001"], TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--project=<id> is required");
    });

    it("errors when --task is missing", async () => {
      const result = await runCli(
        ["task", "done", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--task=<task-id> is required");
    });

    it("errors when the project has no tasks.json", async () => {
      const result = await runCli(
        ["task", "done", "--project=ghost", "--task=gs-001"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no tasks file for project");
    });

    it("errors when the task id is not found", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "pending", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await runCli(
        ["task", "done", "--project=proj", "--task=gs-999"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("gs-999");
      expect(result.stderr).toContain("not found");
      expect(result.stderr).toContain("gs-001");
    });

    it("prints a notice (exit 0) when task is already done", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "done", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await runCli(
        ["task", "done", "--project=proj", "--task=gs-001"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("already done");
    });

    it("marks a task as done and persists the change", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "open", status: "pending", priority: 1 },
        { id: "gs-002", title: "other", status: "pending", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify(seed, null, 2),
      );
      const result = await runCli(
        ["task", "done", "--project=proj", "--task=gs-001"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Marked gs-001");

      const stored = JSON.parse(
        readFileSync(join(TEST_DIR, "state", "proj", "tasks.json"), "utf8"),
      );
      expect(stored[0].status).toBe("done");
      expect(stored[1].status).toBe("pending");
    });
  });

  describe("task count", () => {
    it("reports pending, done, and total for a single project", async () => {
      const seed: GreenfieldTask[] = [
        { id: "gs-001", title: "a", status: "pending", priority: 1 },
        { id: "gs-002", title: "b", status: "in_progress", priority: 1 },
        { id: "gs-003", title: "c", status: "done", priority: 1 },
        { id: "gs-004", title: "d", status: "done", priority: 1 },
        { id: "gs-005", title: "e", status: "skipped", priority: 1 },
      ];
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify(seed),
      );
      const result = await runCli(
        ["task", "count", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("proj: 2 pending, 2 done (5 total)");
    });

    it("reports all-zero counts when tasks.json is missing for --project", async () => {
      const result = await runCli(
        ["task", "count", "--project=ghost"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ghost: 0 pending, 0 done (0 total)");
    });

    it("surfaces malformed JSON as an error", async () => {
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        "{bad json",
      );
      const result = await runCli(
        ["task", "count", "--project=proj"],
        TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Failed to load tasks");
    });

    it("counts across all projects when --project is omitted", async () => {
      const PROJECTS_YAML = `
projects:
  - id: proj
    path: /tmp/proj
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - README.md
  - id: other
    path: /tmp/other
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - README.md
dispatcher:
  state_dir: ./state
  fleet_state_file: ./fleet_state.json
  stop_file: ./STOP
  override_file: ./next_project.txt
  picker: priority_x_staleness
  max_cycles_per_project_per_session: 3
  log_dir: ./logs
  digest_dir: ./digests
`;
      writeFileSync(join(TEST_DIR, "projects.yaml"), PROJECTS_YAML);
      writeFileSync(
        join(TEST_DIR, "state", "proj", "tasks.json"),
        JSON.stringify([
          { id: "gs-001", title: "a", status: "pending", priority: 1 },
          { id: "gs-002", title: "b", status: "done", priority: 1 },
        ]),
      );
      mkdirSync(join(TEST_DIR, "state", "other"), { recursive: true });
      writeFileSync(
        join(TEST_DIR, "state", "other", "tasks.json"),
        JSON.stringify([
          { id: "ot-001", title: "x", status: "done", priority: 1 },
          { id: "ot-002", title: "y", status: "done", priority: 1 },
          { id: "ot-003", title: "z", status: "pending", priority: 1 },
        ]),
      );
      const result = await runCli(["task", "count"], TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("proj: 1 pending, 1 done (2 total)");
      expect(result.stdout).toContain("other: 1 pending, 2 done (3 total)");
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
    expect(result.stdout).toContain("task done");
    expect(result.stdout).toContain("task count");
  });
});

describe("CLI cycle-redo command", () => {
  const TEST_DIR = join(import.meta.dir, "fixtures", "cycle_redo_test");

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "state", "proj"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("errors when --project is missing", async () => {
    const result = await runCli(["cycle-redo", "--task=gs-001"], TEST_DIR);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--project=<id> is required");
  });

  it("errors when --task is missing", async () => {
    const result = await runCli(["cycle-redo", "--project=proj"], TEST_DIR);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--task=<task-id> is required");
  });

  it("errors when the project has no tasks.json", async () => {
    const result = await runCli(
      ["cycle-redo", "--project=ghost", "--task=gs-001"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no tasks file for project");
  });

  it("errors when the task id is not found", async () => {
    const seed: GreenfieldTask[] = [
      { id: "gs-001", title: "a", status: "done", priority: 1 },
    ];
    writeFileSync(
      join(TEST_DIR, "state", "proj", "tasks.json"),
      JSON.stringify(seed),
    );
    const result = await runCli(
      ["cycle-redo", "--project=proj", "--task=gs-999"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gs-999");
    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("gs-001");
  });

  it("prints a notice (exit 0) when task is already pending", async () => {
    const seed: GreenfieldTask[] = [
      { id: "gs-001", title: "a", status: "pending", priority: 1 },
    ];
    writeFileSync(
      join(TEST_DIR, "state", "proj", "tasks.json"),
      JSON.stringify(seed),
    );
    const result = await runCli(
      ["cycle-redo", "--project=proj", "--task=gs-001"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already pending");
  });

  it("reopens a done task as pending and persists the change", async () => {
    const seed: GreenfieldTask[] = [
      { id: "gs-001", title: "reopen me", status: "done", priority: 1 },
      { id: "gs-002", title: "other", status: "done", priority: 1 },
    ];
    writeFileSync(
      join(TEST_DIR, "state", "proj", "tasks.json"),
      JSON.stringify(seed, null, 2),
    );
    const result = await runCli(
      ["cycle-redo", "--project=proj", "--task=gs-001"],
      TEST_DIR,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Reopened gs-001");

    const stored = JSON.parse(
      readFileSync(join(TEST_DIR, "state", "proj", "tasks.json"), "utf8"),
    );
    expect(stored[0].status).toBe("pending");
    expect(stored[1].status).toBe("done");
  });

  it("is listed in --help output", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("generalstaff cycle-redo");
  });
});
