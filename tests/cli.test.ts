import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(args: string[], cwd?: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
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

describe("CLI", () => {
  describe("--version", () => {
    it("prints the version and exits 0", async () => {
      const result = await runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0.0.1");
    });

    it("accepts -v shorthand", async () => {
      const result = await runCli(["-v"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("0.0.1");
    });
  });

  describe("--help", () => {
    it("prints usage and exits 0", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff v0.0.1");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("session");
      expect(result.stdout).toContain("cycle");
      expect(result.stdout).toContain("status");
    });

    it("accepts -h shorthand", async () => {
      const result = await runCli(["-h"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  });

  describe("no arguments", () => {
    it("prints usage and exits 0", async () => {
      const result = await runCli([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  });

  describe("unknown command", () => {
    it("prints error and exits 1", async () => {
      const result = await runCli(["bogus"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command: bogus");
    });

    it("also prints usage after the error", async () => {
      const result = await runCli(["notacommand"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command: notacommand");
      // Usage is printed to stdout after the error
      expect(result.stdout).toContain("Usage:");
    });
  });

  describe("projects", () => {
    const PROJECTS_TEST_DIR = join(import.meta.dir, "fixtures", "projects_cmd_test");

    const PROJECTS_YAML = `
projects:
  - id: alpha
    path: /tmp/alpha
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
    hands_off:
      - CLAUDE.md
  - id: beta
    path: /tmp/beta
    priority: 3
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 45
    branch: main
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
      mkdirSync(PROJECTS_TEST_DIR, { recursive: true });
      writeFileSync(join(PROJECTS_TEST_DIR, "projects.yaml"), PROJECTS_YAML);
    });

    afterEach(() => {
      rmSync(PROJECTS_TEST_DIR, { recursive: true, force: true });
    });

    it("lists all registered projects with key fields", async () => {
      const result = await runCli(["projects"], PROJECTS_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("alpha");
      expect(result.stdout).toContain("/tmp/alpha");
      expect(result.stdout).toContain("priority: 1");
      expect(result.stdout).toContain("30 min");
      expect(result.stdout).toContain("bot/work");
      expect(result.stdout).toContain("beta");
      expect(result.stdout).toContain("/tmp/beta");
      expect(result.stdout).toContain("priority: 3");
      expect(result.stdout).toContain("45 min");
      expect(result.stdout).toContain("main");
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("projects");
    });
  });

  describe("status --json", () => {
    const STATUS_TEST_DIR = join(import.meta.dir, "fixtures", "status_json_test");

    const MINIMAL_PROJECTS_YAML = `
projects:
  - id: alpha
    path: /tmp/alpha
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
  - id: beta
    path: /tmp/beta
    priority: 3
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 45
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
      mkdirSync(STATUS_TEST_DIR, { recursive: true });
      writeFileSync(join(STATUS_TEST_DIR, "projects.yaml"), MINIMAL_PROJECTS_YAML);
    });

    afterEach(() => {
      rmSync(STATUS_TEST_DIR, { recursive: true, force: true });
    });

    it("outputs valid JSON with correct structure", async () => {
      const result = await runCli(["status", "--json"], STATUS_TEST_DIR);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.stopped).toBe(false);
      expect(parsed.projects).toBeArrayOfSize(2);
      expect(parsed.projects[0].id).toBe("alpha");
      expect(parsed.projects[0].priority).toBe(1);
      expect(parsed.projects[0].state).toBeNull();
      expect(parsed.projects[1].id).toBe("beta");
      expect(parsed.projects[1].priority).toBe(3);
    });

    it("includes fleet state when fleet_state.json exists", async () => {
      const fleetState = {
        version: 1,
        updated_at: "2026-04-16T00:00:00.000Z",
        projects: {
          alpha: {
            last_cycle_at: "2026-04-15T12:00:00.000Z",
            last_cycle_outcome: "verified",
            total_cycles: 5,
            total_verified: 4,
            total_failed: 1,
            accumulated_minutes: 120,
          },
        },
      };
      writeFileSync(
        join(STATUS_TEST_DIR, "fleet_state.json"),
        JSON.stringify(fleetState),
      );

      const result = await runCli(["status", "--json"], STATUS_TEST_DIR);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.projects[0].id).toBe("alpha");
      expect(parsed.projects[0].state.total_cycles).toBe(5);
      expect(parsed.projects[0].state.last_cycle_outcome).toBe("verified");
      expect(parsed.projects[1].state).toBeNull(); // beta has no state
    });

    it("reflects STOP file presence", async () => {
      writeFileSync(join(STATUS_TEST_DIR, "STOP"), "");

      const result = await runCli(["status", "--json"], STATUS_TEST_DIR);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.stopped).toBe(true);
    });

    it("without --json outputs formatted text", async () => {
      const result = await runCli(["status"], STATUS_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("=== GeneralStaff Fleet Status ===");
      expect(result.stdout).toContain("alpha (priority 1)");

      // Ensure it's NOT JSON
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  describe("history", () => {
    const HISTORY_TEST_DIR = join(import.meta.dir, "fixtures", "history_cmd_test");

    function makeCycleEnd(i: number, project: string): string {
      return JSON.stringify({
        timestamp: `2026-04-16T12:${String(i).padStart(2, "0")}:00.000Z`,
        event: "cycle_end",
        cycle_id: `cycle-${String(i).padStart(3, "0")}abcdef`,
        project_id: project,
        data: {
          outcome: i % 2 === 0 ? "verified" : "verification_failed",
          start_sha: `aaa${i}000111`,
          end_sha: `bbb${i}000222`,
          duration_seconds: 60 + i * 10,
        },
      });
    }

    beforeEach(() => {
      mkdirSync(join(HISTORY_TEST_DIR, "state", "proj-alpha"), { recursive: true });
      mkdirSync(join(HISTORY_TEST_DIR, "state", "proj-beta"), { recursive: true });
      const alphaLines = Array.from({ length: 5 }, (_, i) => makeCycleEnd(i, "proj-alpha")).join("\n") + "\n";
      const betaLines = Array.from({ length: 3 }, (_, i) => makeCycleEnd(i + 10, "proj-beta")).join("\n") + "\n";
      writeFileSync(join(HISTORY_TEST_DIR, "state", "proj-alpha", "PROGRESS.jsonl"), alphaLines);
      writeFileSync(join(HISTORY_TEST_DIR, "state", "proj-beta", "PROGRESS.jsonl"), betaLines);
    });

    afterEach(() => {
      rmSync(HISTORY_TEST_DIR, { recursive: true, force: true });
    });

    it("shows a table with header and data rows across all projects", async () => {
      const result = await runCli(["history"], HISTORY_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CYCLE");
      expect(result.stdout).toContain("PROJECT");
      expect(result.stdout).toContain("OUTCOME");
      expect(result.stdout).toContain("proj-alpha");
      expect(result.stdout).toContain("proj-beta");
      // 8 data rows (5 alpha + 3 beta) + header + separator = 10 lines
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(10);
    });

    it("filters by --project", async () => {
      const result = await runCli(["history", "--project=proj-beta"], HISTORY_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("proj-beta");
      expect(result.stdout).not.toContain("proj-alpha");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(5); // header + separator + 3 data rows
    });

    it("respects --lines limit", async () => {
      const result = await runCli(["history", "--lines=2"], HISTORY_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(4); // header + separator + 2 data rows
    });

    it("shows 'No cycle history' when state dir is empty", async () => {
      const emptyDir = join(import.meta.dir, "fixtures", "history_empty_test");
      mkdirSync(emptyDir, { recursive: true });
      const result = await runCli(["history"], emptyDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No cycle history found.");
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("history");
    });
  });

  describe("log --lines", () => {
    const LOG_TEST_DIR = join(import.meta.dir, "fixtures", "log_lines_test");

    function makeEntry(i: number): string {
      return JSON.stringify({
        timestamp: `2026-04-16T12:${String(i).padStart(2, "0")}:00.000Z`,
        event: "cycle_start",
        cycle_id: `c-${String(i).padStart(3, "0")}`,
        project_id: "proj-log",
        data: { start_sha: `sha${i}` },
      });
    }

    beforeEach(() => {
      mkdirSync(join(LOG_TEST_DIR, "state", "proj-log"), { recursive: true });
      // Write 25 entries so we can test default (20) and explicit limits
      const lines = Array.from({ length: 25 }, (_, i) => makeEntry(i)).join("\n") + "\n";
      writeFileSync(join(LOG_TEST_DIR, "state", "proj-log", "PROGRESS.jsonl"), lines);
    });

    afterEach(() => {
      rmSync(LOG_TEST_DIR, { recursive: true, force: true });
    });

    it("--lines=5 shows exactly 5 entries", async () => {
      const result = await runCli(["log", "--project=proj-log", "--lines=5"], LOG_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const outputLines = result.stdout.trim().split("\n");
      expect(outputLines).toHaveLength(5);
      // Should be the last 5 entries (indices 20-24)
      expect(outputLines[0]).toContain("c-020");
      expect(outputLines[4]).toContain("c-024");
    });

    it("defaults to 20 lines when --lines is omitted", async () => {
      const result = await runCli(["log", "--project=proj-log"], LOG_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const outputLines = result.stdout.trim().split("\n");
      expect(outputLines).toHaveLength(20);
      // Should be the last 20 entries (indices 5-24)
      expect(outputLines[0]).toContain("c-005");
      expect(outputLines[19]).toContain("c-024");
    });
  });
});
