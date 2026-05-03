// Integration test for `gs phase` CLI command. Spawns the CLI as
// a subprocess so the full flow runs (parse args -> dispatch ->
// load roadmap -> evaluate -> advance -> seed -> emit progress).

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const TEST_DIR = join(import.meta.dir, "fixtures", "phase_advance_test");

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    cwd: TEST_DIR,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const PROJ = "phase-int";
const PROJECTS_YAML = `
projects:
  - id: ${PROJ}
    path: ${TEST_DIR}
    priority: 1
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

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "state", PROJ), { recursive: true });
  writeFileSync(join(TEST_DIR, "projects.yaml"), PROJECTS_YAML);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("gs phase init", () => {
  it("scaffolds a default ROADMAP.yaml", async () => {
    const r = await runCli(["phase", "init", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Wrote");
    expect(existsSync(join(TEST_DIR, "state", PROJ, "ROADMAP.yaml"))).toBe(true);
    const content = readFileSync(
      join(TEST_DIR, "state", PROJ, "ROADMAP.yaml"),
      "utf-8",
    );
    expect(content).toContain(`project_id: ${PROJ}`);
    expect(content).toContain("current_phase: mvp");
  });

  it("refuses to overwrite without --force", async () => {
    writeFileSync(
      join(TEST_DIR, "state", PROJ, "ROADMAP.yaml"),
      "# existing",
      "utf-8",
    );
    const r = await runCli(["phase", "init", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Use --force");
    expect(readFileSync(join(TEST_DIR, "state", PROJ, "ROADMAP.yaml"), "utf-8")).toBe("# existing");
  });

  it("overwrites with --force", async () => {
    writeFileSync(
      join(TEST_DIR, "state", PROJ, "ROADMAP.yaml"),
      "# existing",
      "utf-8",
    );
    const r = await runCli(["phase", "init", `--project=${PROJ}`, "--force"]);
    expect(r.exitCode).toBe(0);
    expect(
      readFileSync(join(TEST_DIR, "state", PROJ, "ROADMAP.yaml"), "utf-8"),
    ).toContain(`project_id: ${PROJ}`);
  });

  it("rejects unknown project id", async () => {
    const r = await runCli(["phase", "init", "--project=nonexistent"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});

describe("gs phase status", () => {
  it("errors when ROADMAP.yaml is missing", async () => {
    const r = await runCli(["phase", "status", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  it("shows current phase + criteria for fresh roadmap", async () => {
    await runCli(["phase", "init", `--project=${PROJ}`]);
    const r = await runCli(["phase", "status", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("current_phase:");
    expect(r.stdout).toContain("mvp");
    expect(r.stdout).toContain("Completion criteria:");
    // No tasks file yet, so all_tasks_done passes vacuously
    expect(r.stdout).toContain("[x] all_tasks_done");
    expect(r.stdout).toContain("All criteria passed");
  });

  it("--json emits structured output", async () => {
    await runCli(["phase", "init", `--project=${PROJ}`]);
    const r = await runCli(["phase", "status", `--project=${PROJ}`, "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.project_id).toBe(PROJ);
    expect(parsed.current_phase).toBe("mvp");
    expect(parsed.next_phase).toBe("launch");
    expect(parsed.all_passed).toBe(true);
  });
});

describe("gs phase advance", () => {
  beforeEach(async () => {
    await runCli(["phase", "init", `--project=${PROJ}`]);
  });

  it("advances mvp -> launch when criteria pass + seeds tasks", async () => {
    const r = await runCli(["phase", "advance", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Advanced ${PROJ}: mvp -> launch`);
    expect(r.stdout).toContain("Seeded 2 tasks");

    // PHASE_STATE.json reflects advance
    const phaseState = JSON.parse(
      readFileSync(join(TEST_DIR, "state", PROJ, "PHASE_STATE.json"), "utf-8"),
    );
    expect(phaseState.current_phase).toBe("launch");
    expect(phaseState.completed_phases).toHaveLength(1);
    expect(phaseState.completed_phases[0].phase_id).toBe("mvp");

    // tasks.json got the 2 launch-phase tasks
    const tasks = JSON.parse(
      readFileSync(join(TEST_DIR, "state", PROJ, "tasks.json"), "utf-8"),
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Smoke-test the live deployment");
    expect(tasks[0].priority).toBe(1);
    expect(tasks[1].title).toBe("First-user announcement post");
    expect(tasks[1].priority).toBe(2);

    // PROGRESS.jsonl carries phase_complete + phase_advanced
    const progress = readFileSync(
      join(TEST_DIR, "state", PROJ, "PROGRESS.jsonl"),
      "utf-8",
    );
    expect(progress).toContain('"event":"phase_complete"');
    expect(progress).toContain('"event":"phase_advanced"');
    expect(progress).toContain('"from_phase":"mvp"');
    expect(progress).toContain('"to_phase":"launch"');
  });

  it("blocks advance when criteria don't pass", async () => {
    // Add a pending task so all_tasks_done fails
    writeFileSync(
      join(TEST_DIR, "state", PROJ, "tasks.json"),
      JSON.stringify(
        [{ id: "t-001", title: "open task", status: "pending", priority: 1 }],
        null,
        2,
      ),
    );
    const r = await runCli(["phase", "advance", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Cannot advance");
    expect(r.stderr).toContain("[ ] all_tasks_done");
    // PHASE_STATE.json was NOT written
    expect(existsSync(join(TEST_DIR, "state", PROJ, "PHASE_STATE.json"))).toBe(false);
  });

  it("--force bypasses unmet criteria", async () => {
    writeFileSync(
      join(TEST_DIR, "state", PROJ, "tasks.json"),
      JSON.stringify(
        [{ id: "t-001", title: "open task", status: "pending", priority: 1 }],
        null,
        2,
      ),
    );
    const r = await runCli(["phase", "advance", `--project=${PROJ}`, "--force"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Advanced ${PROJ}: mvp -> launch`);
    expect(r.stdout).toContain("(advanced with --force; criteria were not met)");

    // PROGRESS.jsonl records forced=true
    const progress = readFileSync(
      join(TEST_DIR, "state", PROJ, "PROGRESS.jsonl"),
      "utf-8",
    );
    expect(progress).toContain('"forced":true');
  });

  it("errors when phase has no next_phase (terminal)", async () => {
    // Advance once mvp -> launch, then try to advance from launch (terminal).
    await runCli(["phase", "advance", `--project=${PROJ}`]);
    // launch phase has no next_phase in the default roadmap.
    // After mvp->launch advance, two new pending tasks exist on launch
    // phase, so we need to mark them done before the advance test, OR
    // we can use --force. We're testing the terminal-phase guard, not
    // the criteria evaluator, so close all tasks first.
    const tasksPath = join(TEST_DIR, "state", PROJ, "tasks.json");
    const tasks = JSON.parse(readFileSync(tasksPath, "utf-8"));
    for (const t of tasks) t.status = "done";
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));

    const r = await runCli(["phase", "advance", `--project=${PROJ}`]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("terminal");
  });

  it("rejects unknown project id", async () => {
    const r = await runCli(["phase", "advance", "--project=nonexistent"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});

describe("gs phase --help", () => {
  it("prints usage when no subcommand", async () => {
    const r = await runCli(["phase"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: generalstaff phase");
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("advance");
    expect(r.stdout).toContain("init");
  });

  it("prints usage on --help", async () => {
    const r = await runCli(["phase", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: generalstaff phase");
  });

  it("errors on unknown subcommand", async () => {
    const r = await runCli(["phase", "totally-fake-sub"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown phase subcommand");
  });
});
