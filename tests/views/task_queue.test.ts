import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setRootDir } from "../../src/state";
import {
  getProjectTaskQueue,
  TaskQueueError,
} from "../../src/views/task_queue";

const FIXTURE_DIR = join(tmpdir(), `gs-task-queue-${process.pid}`);

interface TaskInput {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  priority: number;
  interactive_only?: boolean;
  expected_touches?: string[];
  completed_at?: string;
}

function writeYaml(
  projects: Array<{
    id: string;
    path: string;
    priority?: number;
    hands_off?: string[];
  }>,
) {
  const yaml = [
    "projects:",
    ...projects.flatMap((p) => [
      `  - id: ${p.id}`,
      `    path: ${p.path.replace(/\\/g, "/")}`,
      `    priority: ${p.priority ?? 1}`,
      `    engineer_command: "echo"`,
      `    verification_command: "echo"`,
      `    cycle_budget_minutes: 30`,
      `    branch: bot/work`,
      `    auto_merge: false`,
      `    hands_off:`,
      ...(p.hands_off && p.hands_off.length > 0
        ? p.hands_off.map((h) => `      - ${h}`)
        : [`      - secret/`]),
    ]),
    "dispatcher:",
    "  max_parallel_slots: 1",
  ].join("\n");
  writeFileSync(join(FIXTURE_DIR, "projects.yaml"), yaml, "utf8");
}

function makeProjectDir(
  id: string,
  tasks: TaskInput[] | null,
): string {
  const dir = join(FIXTURE_DIR, `proj-${id}`);
  const stateDir = join(dir, "state", id);
  mkdirSync(stateDir, { recursive: true });
  if (tasks !== null) {
    writeFileSync(
      join(stateDir, "tasks.json"),
      JSON.stringify(tasks, null, 2),
    );
  }
  return dir;
}

beforeEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  setRootDir(FIXTURE_DIR);
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("getProjectTaskQueue", () => {
  it("buckets tasks by status/pickability (4-bucket happy path)", async () => {
    const path = makeProjectDir("alpha", [
      { id: "a-1", title: "doing it", status: "in_progress", priority: 1 },
      { id: "a-2", title: "ready one", status: "pending", priority: 1 },
      { id: "a-3", title: "ready two", status: "pending", priority: 2 },
      {
        id: "a-4",
        title: "interactive only",
        status: "pending",
        priority: 1,
        interactive_only: true,
      },
      {
        id: "a-5",
        title: "hands-off conflict",
        status: "pending",
        priority: 2,
        expected_touches: ["secret/keys.ts"],
      },
      {
        id: "a-6",
        title: "done",
        status: "done",
        priority: 1,
        completed_at: "2026-04-18T10:00:00Z",
      },
      { id: "a-7", title: "skipped", status: "skipped", priority: 3 },
    ]);
    writeYaml([{ id: "alpha", path, hands_off: ["secret/"] }]);

    const data = await getProjectTaskQueue("alpha");

    expect(data.project_id).toBe("alpha");
    expect(data.in_flight).toHaveLength(1);
    expect(data.in_flight[0].id).toBe("a-1");

    expect(data.ready.map((e) => e.id).sort()).toEqual(["a-2", "a-3"]);

    expect(data.blocked).toHaveLength(2);
    const a4 = data.blocked.find((e) => e.id === "a-4")!;
    expect(a4.block_reason).toBe("interactive_only");
    const a5 = data.blocked.find((e) => e.id === "a-5")!;
    expect(a5.block_reason).toBe("hands_off_intersect");

    expect(data.shipped).toHaveLength(1);
    expect(data.shipped[0].id).toBe("a-6");
    expect(data.shipped[0].completed_at).toBe("2026-04-18T10:00:00Z");
  });

  it("throws TaskQueueError for unknown projectId", async () => {
    const path = makeProjectDir("alpha", []);
    writeYaml([{ id: "alpha", path }]);

    let caught: unknown;
    try {
      await getProjectTaskQueue("ghost");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TaskQueueError);
    expect((caught as Error).message).toContain("ghost");
  });

  it("returns empty-buckets TaskQueueData when tasks.json is missing", async () => {
    const path = makeProjectDir("alpha", null);
    writeYaml([{ id: "alpha", path }]);

    const data = await getProjectTaskQueue("alpha");
    expect(data).toEqual({
      project_id: "alpha",
      in_flight: [],
      ready: [],
      blocked: [],
      shipped: [],
    });
  });

  it("caps shipped at 8 most-recent, newest first", async () => {
    const tasks: TaskInput[] = Array.from({ length: 10 }, (_, i) => ({
      id: `d-${i + 1}`,
      title: `done ${i + 1}`,
      status: "done" as const,
      priority: 1,
      // Encode ordering in the timestamp so newer idx => newer ISO.
      completed_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const path = makeProjectDir("alpha", tasks);
    writeYaml([{ id: "alpha", path }]);

    const data = await getProjectTaskQueue("alpha");
    expect(data.shipped).toHaveLength(8);
    // Newest first — d-10, d-9, ..., d-3
    expect(data.shipped[0].id).toBe("d-10");
    expect(data.shipped[7].id).toBe("d-3");
  });

  it("interactive_only pending task → blocked with block_reason interactive_only", async () => {
    const path = makeProjectDir("alpha", [
      {
        id: "a-1",
        title: "t",
        status: "pending",
        priority: 1,
        interactive_only: true,
      },
    ]);
    writeYaml([{ id: "alpha", path }]);

    const data = await getProjectTaskQueue("alpha");
    expect(data.blocked).toHaveLength(1);
    expect(data.blocked[0].block_reason).toBe("interactive_only");
    expect(data.ready).toHaveLength(0);
  });

  it("hands_off conflict via expected_touches → blocked with block_reason hands_off_intersect", async () => {
    const path = makeProjectDir("alpha", [
      {
        id: "a-1",
        title: "t",
        status: "pending",
        priority: 1,
        expected_touches: ["src/safety.ts"],
      },
    ]);
    writeYaml([{ id: "alpha", path, hands_off: ["src/safety.ts"] }]);

    const data = await getProjectTaskQueue("alpha");
    expect(data.blocked).toHaveLength(1);
    expect(data.blocked[0].block_reason).toBe("hands_off_intersect");
  });

  it("pending task without expected_touches is ready (no hands_off check)", async () => {
    const path = makeProjectDir("alpha", [
      { id: "a-1", title: "t", status: "pending", priority: 1 },
    ]);
    writeYaml([{ id: "alpha", path, hands_off: ["src/safety.ts"] }]);

    const data = await getProjectTaskQueue("alpha");
    expect(data.ready).toHaveLength(1);
    expect(data.ready[0].id).toBe("a-1");
    expect(data.blocked).toHaveLength(0);
  });
});
