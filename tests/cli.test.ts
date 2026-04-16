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
});
