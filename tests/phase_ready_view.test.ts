// Integration test for the phase-ready view + CLI dispatch.

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
const TEST_DIR = join(import.meta.dir, "fixtures", "phase_ready_view_test");

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

const PROJECTS_YAML = `
projects:
  - id: alpha
    path: ${TEST_DIR}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - README.md
  - id: beta
    path: ${TEST_DIR}
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

function writeSentinel(projectId: string, fromPhase: string, toPhase: string, ageSeconds = 0): void {
  const dir = join(TEST_DIR, "state", projectId);
  mkdirSync(dir, { recursive: true });
  const detected = new Date(Date.now() - ageSeconds * 1000).toISOString();
  writeFileSync(
    join(dir, "PHASE_READY.json"),
    JSON.stringify(
      {
        project_id: projectId,
        from_phase: fromPhase,
        to_phase: toPhase,
        detected_at: detected,
        criteria_results: [
          { kind: "all_tasks_done", passed: true, detail: "ok" },
        ],
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_DIR, "state", "alpha"), { recursive: true });
  mkdirSync(join(TEST_DIR, "state", "beta"), { recursive: true });
  writeFileSync(join(TEST_DIR, "projects.yaml"), PROJECTS_YAML);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("gs view phase-ready", () => {
  it("reports 'No projects ready' when no sentinel files exist", async () => {
    const r = await runCli(["view", "phase-ready"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No projects ready to advance");
    expect(r.stdout).toContain("Scanned 2 projects");
  });

  it("lists ready projects when sentinels exist", async () => {
    writeSentinel("alpha", "mvp", "billing", 120);
    writeSentinel("beta", "billing", "ads", 30);
    const r = await runCli(["view", "phase-ready"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("alpha");
    expect(r.stdout).toContain("mvp -> billing");
    expect(r.stdout).toContain("beta");
    expect(r.stdout).toContain("billing -> ads");
    expect(r.stdout).toContain("2 ready");
  });

  it("--json emits structured output", async () => {
    writeSentinel("alpha", "mvp", "billing", 120);
    const r = await runCli(["view", "phase-ready", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ready).toHaveLength(1);
    expect(parsed.ready[0].project_id).toBe("alpha");
    expect(parsed.ready[0].from_phase).toBe("mvp");
    expect(parsed.ready[0].to_phase).toBe("billing");
    expect(parsed.total_projects_scanned).toBe(2);
    expect(parsed.total_with_roadmap).toBe(0);
  });

  it("sorts oldest-detected first", async () => {
    writeSentinel("beta", "billing", "ads", 30);
    writeSentinel("alpha", "mvp", "billing", 600);
    const r = await runCli(["view", "phase-ready", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // alpha is older, should be first
    expect(parsed.ready[0].project_id).toBe("alpha");
    expect(parsed.ready[1].project_id).toBe("beta");
  });

  it("counts total_with_roadmap correctly", async () => {
    // Add a ROADMAP.yaml for alpha (no sentinel needed for this count)
    writeFileSync(
      join(TEST_DIR, "state", "alpha", "ROADMAP.yaml"),
      "project_id: alpha\ncurrent_phase: mvp\nphases: []\n",
    );
    const r = await runCli(["view", "phase-ready", "--json"]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.total_with_roadmap).toBe(1);
  });

  it("skips corrupted sentinels silently", async () => {
    mkdirSync(join(TEST_DIR, "state", "alpha"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "state", "alpha", "PHASE_READY.json"),
      "{not valid json",
    );
    writeSentinel("beta", "billing", "ads", 30);
    const r = await runCli(["view", "phase-ready"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("beta");
    expect(r.stdout).not.toContain("alpha");
    expect(r.stdout).toContain("1 ready");
  });
});

describe("gs phase advance — clears PHASE_READY sentinel", () => {
  it("removes the sentinel after a successful advance", async () => {
    // Setup: write a roadmap so advance has somewhere to go
    writeFileSync(
      join(TEST_DIR, "state", "alpha", "ROADMAP.yaml"),
      `project_id: alpha
current_phase: mvp
phases:
  - id: mvp
    goal: "first"
    completion_criteria:
      - all_tasks_done: true
    next_phase: launch
  - id: launch
    goal: "second"
    completion_criteria:
      - all_tasks_done: true
`,
    );
    writeSentinel("alpha", "mvp", "launch", 60);
    expect(existsSync(join(TEST_DIR, "state", "alpha", "PHASE_READY.json"))).toBe(true);

    const r = await runCli(["phase", "advance", "--project=alpha"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Advanced alpha");
    expect(existsSync(join(TEST_DIR, "state", "alpha", "PHASE_READY.json"))).toBe(false);
  });
});
