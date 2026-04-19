import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { $ } from "bun";

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

    it("advertises --verbose on session", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--verbose");
      expect(result.stdout).toContain("stream PROGRESS.jsonl events");
    });

    it("advertises --chain on session", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--chain");
      expect(result.stdout).toContain("back-to-back sessions");
    });
  });

  describe("session --chain validation", () => {
    it("rejects --chain=0 with a clear error", async () => {
      const result = await runCli(["session", "--chain=0"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--chain must be a positive integer");
    });

    it("rejects non-numeric --chain values", async () => {
      const result = await runCli(["session", "--chain=abc"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--chain must be a positive integer");
    });

    it("rejects negative --chain values", async () => {
      const result = await runCli(["session", "--chain=-1"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--chain must be a positive integer");
    });
  });

  describe("session --project (gs-214)", () => {
    const PROJECT_FLAG_DIR = join(
      import.meta.dir,
      "fixtures",
      "session_project_flag_test",
    );

    const PROJECT_FLAG_YAML = `
projects:
  - id: alpha
    path: /tmp/generalstaff_test_nonexistent_alpha_xyz
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
  - id: beta
    path: /tmp/generalstaff_test_nonexistent_beta_xyz
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
  - id: gamma
    path: /tmp/generalstaff_test_nonexistent_gamma_xyz
    priority: 3
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
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
      mkdirSync(PROJECT_FLAG_DIR, { recursive: true });
      writeFileSync(
        join(PROJECT_FLAG_DIR, "projects.yaml"),
        PROJECT_FLAG_YAML,
      );
    });

    afterEach(() => {
      rmSync(PROJECT_FLAG_DIR, { recursive: true, force: true });
    });

    it("--project=X resolves to excludeProjects covering the complement", async () => {
      const result = await runCli(
        ["session", "--project=alpha", "--dry-run", "--budget=1"],
        PROJECT_FLAG_DIR,
      );
      expect(result.stdout).toContain("Excluding: beta, gamma");
      expect(result.stdout).not.toMatch(/Excluding:[^\n]*\balpha\b/);
    });

    it("multi-id --project=a,b excludes the rest", async () => {
      const result = await runCli(
        ["session", "--project=alpha,gamma", "--dry-run", "--budget=1"],
        PROJECT_FLAG_DIR,
      );
      expect(result.stdout).toContain("Excluding: beta");
      expect(result.stdout).not.toMatch(/Excluding:[^\n]*\balpha\b/);
      expect(result.stdout).not.toMatch(/Excluding:[^\n]*\bgamma\b/);
    });

    it("--project combined with --exclude-project is a mutex error", async () => {
      const result = await runCli(
        ["session", "--project=alpha", "--exclude-project=beta"],
        PROJECT_FLAG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--project cannot be combined with --exclude-project",
      );
    });

    it("unknown id in --project list warns but does not abort", async () => {
      const result = await runCli(
        [
          "session",
          "--project=alpha,nonexistent_xyz",
          "--dry-run",
          "--budget=1",
        ],
        PROJECT_FLAG_DIR,
      );
      expect(result.stderr).toContain("nonexistent_xyz");
      expect(result.stderr).toContain(
        "does not match any registered project",
      );
      // alpha was resolved, so only beta + gamma get excluded
      expect(result.stdout).toContain("Excluding: beta, gamma");
    });

    it("--help documents --project", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--project=<id>");
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

    it("Last cycle line shows relative time and preserves ISO timestamp", async () => {
      const isoTimestamp = "2026-04-15T12:00:00.000Z";
      const fleetState = {
        version: 1,
        updated_at: "2026-04-16T00:00:00.000Z",
        projects: {
          alpha: {
            last_cycle_at: isoTimestamp,
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

      const result = await runCli(["status"], STATUS_TEST_DIR);
      expect(result.exitCode).toBe(0);
      // ISO timestamp kept in parentheses for precision
      expect(result.stdout).toContain(`(${isoTimestamp})`);
      // A relative fragment (days/hours/ago/yesterday/just now) should precede it
      const lastCycleMatch = result.stdout.match(/Last cycle: (.+) \(2026-04-15T12:00:00\.000Z\)/);
      expect(lastCycleMatch).not.toBeNull();
      expect(lastCycleMatch![1]).not.toBe(isoTimestamp);
      // beta has no state — still shows "never"
      expect(result.stdout).toContain("No cycles yet");
    });

    it("Last cycle line shows 'never' when there is no state", async () => {
      const result = await runCli(["status"], STATUS_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No cycles yet");
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

    it("filters by --outcome=verified", async () => {
      const result = await runCli(["history", "--outcome=verified"], HISTORY_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      // 5 verified rows (3 alpha at i=0,2,4 + 2 beta at i=10,12) + header + separator = 7
      expect(lines).toHaveLength(7);
      expect(result.stdout).not.toContain("verification_failed");
    });

    it("filters by --outcome=verification_failed", async () => {
      const result = await runCli(
        ["history", "--outcome=verification_failed"],
        HISTORY_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      // 3 failed rows (2 alpha at i=1,3 + 1 beta at i=11) + header + separator = 5
      expect(lines).toHaveLength(5);
      expect(result.stdout).toContain("verification_failed");
    });

    it("returns no data rows for --outcome=verified_weak when none exist", async () => {
      const result = await runCli(
        ["history", "--outcome=verified_weak"],
        HISTORY_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No cycle history found.");
    });

    it("returns no data rows for --outcome=cycle_skipped when none exist", async () => {
      const result = await runCli(
        ["history", "--outcome=cycle_skipped"],
        HISTORY_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No cycle history found.");
    });

    it("errors on invalid --outcome value", async () => {
      const result = await runCli(
        ["history", "--outcome=bogus"],
        HISTORY_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown --outcome value");
      expect(result.stderr).toContain("verified");
      expect(result.stderr).toContain("verified_weak");
      expect(result.stderr).toContain("verification_failed");
      expect(result.stderr).toContain("cycle_skipped");
    });

    it("errors when --verified-only and --outcome are both set", async () => {
      const result = await runCli(
        ["history", "--verified-only", "--outcome=verified"],
        HISTORY_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--verified-only and --outcome are mutually exclusive",
      );
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

    it("--tail shows everything (equivalent to --lines=9999)", async () => {
      const result = await runCli(["log", "--project=proj-log", "--tail"], LOG_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const outputLines = result.stdout.trim().split("\n");
      expect(outputLines).toHaveLength(25);
      expect(outputLines[0]).toContain("c-000");
      expect(outputLines[24]).toContain("c-024");
    });

    it("--tail and --lines=N together is rejected as mutually exclusive", async () => {
      const result = await runCli(
        ["log", "--project=proj-log", "--tail", "--lines=5"],
        LOG_TEST_DIR,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--tail and --lines are mutually exclusive");
    });

    it("--tail composes with --grep filter", async () => {
      // grep is case-insensitive over event + data JSON. Match against start_sha
      // values 'sha2', 'sha20'..'sha24' → 6 entries (indices 2, 20..24).
      const result = await runCli(
        ["log", "--project=proj-log", "--tail", "--grep=sha2"],
        LOG_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      const outputLines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
      expect(outputLines).toHaveLength(6);
      expect(outputLines[0]).toContain("c-002");
      expect(outputLines[5]).toContain("c-024");
    });

    it("--tail composes with --since filter", async () => {
      // Entries have timestamps 2026-04-16T12:00..12:24 UTC.
      // Filter to entries at/after 12:20 → indices 20..24 (5 entries).
      const result = await runCli(
        ["log", "--project=proj-log", "--tail", "--since=2026-04-16T12:20:00.000Z"],
        LOG_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      const outputLines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
      expect(outputLines).toHaveLength(5);
      expect(outputLines[0]).toContain("c-020");
      expect(outputLines[4]).toContain("c-024");
    });

    it("--tail composes with --level=error filter", async () => {
      const result = await runCli(
        ["log", "--project=proj-log", "--tail", "--level=error"],
        LOG_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      // All fixture entries are cycle_start (not error events); expect the
      // single-project empty-matches message, and no cycle_start lines.
      expect(result.stdout).toContain("No error-level entries for project");
      expect(result.stdout).not.toContain("cycle_start");
    });
  });

  describe("version command", () => {
    const VERSION_TEST_DIR = join(import.meta.dir, "fixtures", "version_cmd_test");

    beforeEach(() => {
      mkdirSync(VERSION_TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(VERSION_TEST_DIR, { recursive: true, force: true });
    });

    it("prints version, bun, platform, and projects.yaml path", async () => {
      const result = await runCli(["version"], VERSION_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff v0.0.1");
      expect(result.stdout).toContain("bun:");
      expect(result.stdout).toContain(Bun.version);
      expect(result.stdout).toContain("platform:");
      expect(result.stdout).toContain(process.platform);
      expect(result.stdout).toContain("projects.yaml:");
    });

    it("flags missing projects.yaml with '(not found)'", async () => {
      const result = await runCli(["version"], VERSION_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(not found)");
    });

    it("omits '(not found)' when projects.yaml exists", async () => {
      writeFileSync(join(VERSION_TEST_DIR, "projects.yaml"), "projects: []\n");
      const result = await runCli(["version"], VERSION_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("(not found)");
      expect(result.stdout).toContain(join(VERSION_TEST_DIR, "projects.yaml"));
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("generalstaff version");
    });
  });

  describe("config command", () => {
    const CONFIG_TEST_DIR = join(import.meta.dir, "fixtures", "config_cmd_test");

    const CONFIG_YAML = `
projects:
  - id: alpha
    path: /tmp/alpha
    priority: 1
    engineer_command: "echo engineer"
    verification_command: "echo verify"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
      - scripts/
    notes: |
      First line of notes.
      Second line of notes.
  - id: beta
    path: /tmp/beta
    priority: 2
    engineer_command: "run"
    verification_command: "test"
    cycle_budget_minutes: 45
    work_detection: catalogdna_bot_tasks
    concurrency_detection: worktree
    branch: custom/branch
    auto_merge: true
    hands_off:
      - README.md
`;

    beforeEach(() => {
      mkdirSync(CONFIG_TEST_DIR, { recursive: true });
      writeFileSync(join(CONFIG_TEST_DIR, "projects.yaml"), CONFIG_YAML);
    });

    afterEach(() => {
      rmSync(CONFIG_TEST_DIR, { recursive: true, force: true });
    });

    it("pretty-prints all projects with resolved defaults", async () => {
      const result = await runCli(["config"], CONFIG_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("=== GeneralStaff Config ===");
      expect(result.stdout).toContain("Projects: 2");

      // alpha uses defaults
      expect(result.stdout).toContain("[alpha]");
      expect(result.stdout).toContain("/tmp/alpha");
      expect(result.stdout).toContain("priority:             1");
      expect(result.stdout).toContain("cycle_budget_minutes: 30");
      expect(result.stdout).toContain("echo engineer");
      expect(result.stdout).toContain("echo verify");
      // Defaults resolved:
      expect(result.stdout).toContain("work_detection:       tasks_json");
      expect(result.stdout).toContain("concurrency_detection:none");
      expect(result.stdout).toContain("branch:               bot/work");
      expect(result.stdout).toContain("auto_merge:           false");
      expect(result.stdout).toContain("hands_off (2):");
      expect(result.stdout).toContain("- CLAUDE.md");
      expect(result.stdout).toContain("- scripts/");
      expect(result.stdout).toContain("First line of notes.");
      expect(result.stdout).toContain("Second line of notes.");
    });

    it("shows explicit non-default values when set", async () => {
      const result = await runCli(["config"], CONFIG_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[beta]");
      expect(result.stdout).toContain("work_detection:       catalogdna_bot_tasks");
      expect(result.stdout).toContain("concurrency_detection:worktree");
      expect(result.stdout).toContain("branch:               custom/branch");
      expect(result.stdout).toContain("auto_merge:           true");
    });

    it("includes dispatcher section with resolved defaults", async () => {
      const result = await runCli(["config"], CONFIG_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[dispatcher]");
      expect(result.stdout).toContain("picker:                            priority_x_staleness");
      expect(result.stdout).toContain("max_cycles_per_project_per_session:3");
      expect(result.stdout).toContain("state_dir:");
      expect(result.stdout).toContain("fleet_state_file:");
      expect(result.stdout).toContain("stop_file:");
      expect(result.stdout).toContain("log_dir:");
      expect(result.stdout).toContain("digest_dir:");
    });

    it("exits non-zero on invalid config", async () => {
      const BAD_DIR = join(import.meta.dir, "fixtures", "config_bad_test");
      mkdirSync(BAD_DIR, { recursive: true });
      writeFileSync(
        join(BAD_DIR, "projects.yaml"),
        "projects:\n  - id: x\n    path: /tmp/x\n    priority: 1\n    engineer_command: e\n    verification_command: v\n    cycle_budget_minutes: 10\n    hands_off: []\n",
      );
      const result = await runCli(["config"], BAD_DIR);
      expect(result.exitCode).not.toBe(0);
      rmSync(BAD_DIR, { recursive: true, force: true });
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("generalstaff config");
    });
  });

  describe("providers list command", () => {
    const PROV_TEST_DIR = join(import.meta.dir, "fixtures", "providers_list_test");
    const PROV_FILE = join(PROV_TEST_DIR, "provider_config.yaml");

    beforeEach(() => {
      mkdirSync(PROV_TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(PROV_TEST_DIR, { recursive: true, force: true });
    });

    it("prints missing-file message when provider_config.yaml is absent", async () => {
      const result = await runCli(["providers", "list"], PROV_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "No provider_config.yaml found. See provider_config.yaml.example for format.",
      );
    });

    it("emits empty JSON registry when file absent under --json", async () => {
      const result = await runCli(["providers", "list", "--json"], PROV_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.providers).toEqual([]);
      expect(parsed.routes).toEqual({
        digest: null,
        cycle_summary: null,
        classifier: null,
      });
    });

    it("prints provider table and routes when file is present", async () => {
      writeFileSync(
        PROV_FILE,
        `providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
    host: http://localhost:11434
routes:
  digest: ollama_llama3
  cycle_summary: ollama_llama3
`,
      );
      const result = await runCli(["providers", "list"], PROV_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("=== GeneralStaff Providers ===");
      expect(result.stdout).toContain("Providers: 1");
      expect(result.stdout).toContain("[ollama_llama3]");
      expect(result.stdout).toContain("kind:        ollama");
      expect(result.stdout).toContain("model:       llama3:8b");
      expect(result.stdout).toContain("host:        http://localhost:11434");
      expect(result.stdout).toContain("[routes]");
      expect(result.stdout).toContain("digest");
      expect(result.stdout).toContain("ollama_llama3");
      expect(result.stdout).toContain("classifier");
      expect(result.stdout).toContain("(unrouted)");
    });

    it("--json emits full registry shape", async () => {
      writeFileSync(
        PROV_FILE,
        `providers:
  - id: ollama_llama3
    kind: ollama
    model: llama3:8b
routes:
  digest: ollama_llama3
`,
      );
      const result = await runCli(["providers", "list", "--json"], PROV_TEST_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed.providers)).toBe(true);
      expect(parsed.providers).toHaveLength(1);
      expect(parsed.providers[0].id).toBe("ollama_llama3");
      expect(parsed.providers[0].kind).toBe("ollama");
      expect(parsed.providers[0].model).toBe("llama3:8b");
      expect(parsed.routes.digest).toBe("ollama_llama3");
      expect(parsed.routes.cycle_summary).toBeNull();
      expect(parsed.routes.classifier).toBeNull();
    });

    it("exits non-zero on malformed provider_config.yaml", async () => {
      writeFileSync(PROV_FILE, "providers: not-an-array\n");
      const result = await runCli(["providers", "list"], PROV_TEST_DIR);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("providers");
    });

    it("rejects unknown subcommand", async () => {
      const result = await runCli(["providers", "bogus"], PROV_TEST_DIR);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown providers subcommand");
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("generalstaff providers list");
    });
  });

  describe("providers ping command", () => {
    const PING_TEST_DIR = join(import.meta.dir, "fixtures", "providers_ping_test");
    const PING_FILE = join(PING_TEST_DIR, "provider_config.yaml");

    beforeEach(() => {
      mkdirSync(PING_TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(PING_TEST_DIR, { recursive: true, force: true });
    });

    function writeConfig(providers: string) {
      writeFileSync(PING_FILE, `providers:\n${providers}`);
    }

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff providers ping");
    });

    it("errors when provider_config.yaml is absent", async () => {
      const result = await runCli(["providers", "ping", "anything"], PING_TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no provider_config.yaml found");
    });

    it("errors when no provider id or --all is given", async () => {
      writeConfig(
        `  - id: ollama_llama3\n    kind: ollama\n    model: llama3:8b\n    host: http://127.0.0.1:1\n`,
      );
      const result = await runCli(["providers", "ping"], PING_TEST_DIR);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("provider id required");
    });

    it("errors on unknown provider id", async () => {
      writeConfig(
        `  - id: ollama_llama3\n    kind: ollama\n    model: llama3:8b\n    host: http://127.0.0.1:1\n`,
      );
      const result = await runCli(
        ["providers", "ping", "nope"],
        PING_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown provider id 'nope'");
      expect(result.stderr).toContain("ollama_llama3");
    });

    it("reports unreachable and exits 1 when the ollama host is down", async () => {
      writeConfig(
        `  - id: ollama_llama3\n    kind: ollama\n    model: llama3:8b\n    host: http://127.0.0.1:1\n`,
      );
      const result = await runCli(
        ["providers", "ping", "ollama_llama3"],
        PING_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Provider ollama_llama3: unreachable");
    });

    it("--json emits the ProviderHealth object on failure", async () => {
      writeConfig(
        `  - id: ollama_llama3\n    kind: ollama\n    model: llama3:8b\n    host: http://127.0.0.1:1\n`,
      );
      const result = await runCli(
        ["providers", "ping", "ollama_llama3", "--json"],
        PING_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reachable).toBe(false);
      expect(typeof parsed.error).toBe("string");
    });

    it("reports reachable with latency when the ollama host returns 200", async () => {
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/api/tags") {
            return new Response(JSON.stringify({ models: [] }), { status: 200 });
          }
          return new Response("nope", { status: 404 });
        },
      });
      try {
        const host = `http://127.0.0.1:${server.port}`;
        writeConfig(
          `  - id: ollama_llama3\n    kind: ollama\n    model: llama3:8b\n    host: ${host}\n`,
        );
        const result = await runCli(
          ["providers", "ping", "ollama_llama3"],
          PING_TEST_DIR,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Provider ollama_llama3: reachable");
        expect(result.stdout).toMatch(/\(\d+ms\)/);
      } finally {
        server.stop();
      }
    });

    it("--json emits ProviderHealth on success", async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        },
      });
      try {
        const host = `http://127.0.0.1:${server.port}`;
        writeConfig(
          `  - id: ollama_llama3\n    kind: ollama\n    model: llama3:8b\n    host: ${host}\n`,
        );
        const result = await runCli(
          ["providers", "ping", "ollama_llama3", "--json"],
          PING_TEST_DIR,
        );
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.reachable).toBe(true);
        expect(parsed.host).toBe(host);
        expect(typeof parsed.latencyMs).toBe("number");
      } finally {
        server.stop();
      }
    });

    it("--all pings every provider and prints a summary table", async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        },
      });
      try {
        const goodHost = `http://127.0.0.1:${server.port}`;
        writeConfig(
          `  - id: ollama_good\n    kind: ollama\n    model: llama3:8b\n    host: ${goodHost}\n` +
            `  - id: ollama_bad\n    kind: ollama\n    model: llama3:8b\n    host: http://127.0.0.1:1\n`,
        );
        const result = await runCli(
          ["providers", "ping", "--all"],
          PING_TEST_DIR,
        );
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("ollama_good");
        expect(result.stdout).toContain("reachable");
        expect(result.stdout).toContain("ollama_bad");
        expect(result.stdout).toContain("unreachable");
      } finally {
        server.stop();
      }
    });

    it("--all --json emits an array of ProviderHealth objects keyed by id", async () => {
      writeConfig(
        `  - id: ollama_bad\n    kind: ollama\n    model: llama3:8b\n    host: http://127.0.0.1:1\n`,
      );
      const result = await runCli(
        ["providers", "ping", "--all", "--json"],
        PING_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("ollama_bad");
      expect(parsed[0].reachable).toBe(false);
    });

    it("--all exits 0 when zero providers configured (empty registry)", async () => {
      writeFileSync(PING_FILE, "providers: []\n");
      const result = await runCli(
        ["providers", "ping", "--all"],
        PING_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No providers configured");
    });

    it("reports unreachable for non-ollama provider kinds (Phase 2 stub)", async () => {
      writeConfig(
        `  - id: or_flagship\n    kind: openrouter\n    model: qwen/qwen3-coder-plus\n    api_key_env: OPENROUTER_API_KEY\n`,
      );
      const result = await runCli(
        ["providers", "ping", "or_flagship"],
        PING_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not implemented in Phase 2");
    });
  });

  describe("digest command", () => {
    const DIGEST_TEST_DIR = join(import.meta.dir, "fixtures", "digest_cmd_test");
    const DIGEST_DIR = join(DIGEST_TEST_DIR, "digests");

    beforeEach(() => {
      mkdirSync(DIGEST_DIR, { recursive: true });
      writeFileSync(
        join(DIGEST_TEST_DIR, "projects.yaml"),
        `projects:
  - id: x
    path: /tmp/x
    priority: 1
    engineer_command: e
    verification_command: v
    cycle_budget_minutes: 10
    hands_off:
      - CLAUDE.md
`,
      );
    });

    afterEach(() => {
      rmSync(DIGEST_TEST_DIR, { recursive: true, force: true });
    });

    it("prints clear message when no digests exist", async () => {
      rmSync(DIGEST_DIR, { recursive: true, force: true });
      const result = await runCli(["digest", "--latest"], DIGEST_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No digests found");
    });

    it("prints clear message when digests dir is empty", async () => {
      const result = await runCli(["digest", "--latest"], DIGEST_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No digests found");
    });

    it("prints the most recent digest with --latest", async () => {
      writeFileSync(join(DIGEST_DIR, "digest_20260415_100000.md"), "OLD DIGEST\n");
      writeFileSync(join(DIGEST_DIR, "digest_20260416_150000.md"), "NEW DIGEST\n");
      const result = await runCli(["digest", "--latest"], DIGEST_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NEW DIGEST");
      expect(result.stdout).not.toContain("OLD DIGEST");
    });

    it("defaults to --latest when no flag is given", async () => {
      writeFileSync(join(DIGEST_DIR, "digest_20260416_150000.md"), "ONLY DIGEST\n");
      const result = await runCli(["digest"], DIGEST_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ONLY DIGEST");
    });

    it("prints the first digest from a given date", async () => {
      writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), "MORNING\n");
      writeFileSync(join(DIGEST_DIR, "digest_20260416_180000.md"), "EVENING\n");
      writeFileSync(join(DIGEST_DIR, "digest_20260415_120000.md"), "DAY BEFORE\n");
      const result = await runCli(["digest", "--date=20260416"], DIGEST_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MORNING");
      expect(result.stdout).not.toContain("EVENING");
      expect(result.stdout).not.toContain("DAY BEFORE");
    });

    it("reports when no digest exists for a given date", async () => {
      writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), "X\n");
      const result = await runCli(["digest", "--date=20260101"], DIGEST_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No digests found for date 20260101");
    });

    it("rejects malformed --date", async () => {
      writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), "X\n");
      const result = await runCli(["digest", "--date=2026-04-16"], DIGEST_TEST_DIR);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("YYYYMMDD");
    });

    it("rejects combining --latest and --date", async () => {
      const result = await runCli(
        ["digest", "--latest", "--date=20260416"],
        DIGEST_TEST_DIR,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("mutually exclusive");
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("generalstaff digest");
    });

    describe("--list", () => {
      const SAMPLE_DIGEST = (cycles: number, verified: number, failed: number, skipped: number) => {
        let md = `# GeneralStaff Session Digest\n\n**Date:** 2026-04-16T10:00:00.000Z\n**Duration:** 5m\n**Cycles:** ${cycles}\n\n`;
        for (let i = 0; i < verified; i++) md += `## p — c${i}\n\n- **Outcome:** verified\n\n`;
        for (let i = 0; i < failed; i++) md += `## p — f${i}\n\n- **Outcome:** verification_failed\n\n`;
        for (let i = 0; i < skipped; i++) md += `## p — s${i}\n\n- **Outcome:** cycle_skipped\n\n`;
        return md;
      };

      it("prints clear message when digests dir is empty", async () => {
        const result = await runCli(["digest", "--list"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("prints clear message when digests dir does not exist", async () => {
        rmSync(DIGEST_DIR, { recursive: true, force: true });
        const result = await runCli(["digest", "--list"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("lists a single digest with parsed counts", async () => {
        writeFileSync(
          join(DIGEST_DIR, "digest_20260416_100000.md"),
          SAMPLE_DIGEST(3, 2, 1, 0),
        );
        const result = await runCli(["digest", "--list"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("digest_20260416_100000.md");
        expect(result.stdout).toContain("2026-04-16 10:00:00");
        expect(result.stdout).toContain("cycles=3");
        expect(result.stdout).toContain("verified=2");
        expect(result.stdout).toContain("failed=1");
        expect(result.stdout).toContain("skipped=0");
      });

      it("lists multiple digests newest first", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260415_120000.md"), SAMPLE_DIGEST(1, 1, 0, 0));
        writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), SAMPLE_DIGEST(2, 1, 1, 0));
        writeFileSync(join(DIGEST_DIR, "digest_20260416_180000.md"), SAMPLE_DIGEST(4, 2, 1, 1));
        const result = await runCli(["digest", "--list"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        const lines = result.stdout.trim().split("\n");
        expect(lines.length).toBe(3);
        expect(lines[0]).toContain("digest_20260416_180000.md");
        expect(lines[1]).toContain("digest_20260416_090000.md");
        expect(lines[2]).toContain("digest_20260415_120000.md");
        expect(lines[0]).toContain("cycles=4");
        expect(lines[0]).toContain("skipped=1");
      });

      it("rejects combining --list with --latest", async () => {
        const result = await runCli(
          ["digest", "--list", "--latest"],
          DIGEST_TEST_DIR,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("--list cannot be combined");
      });

      it("rejects combining --list with --date", async () => {
        const result = await runCli(
          ["digest", "--list", "--date=20260416"],
          DIGEST_TEST_DIR,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("--list cannot be combined");
      });
    });

    describe("--json", () => {
      const FULL_DIGEST = `# GeneralStaff Session Digest

**Date:** 2026-04-16T10:00:00.000Z
**Duration:** 5m
**Cycles:** 2

## alpha — c1

- **Outcome:** verified
- **Reason:** tests pass
- **SHA:** aaaaaaaa → bbbbbbbb
- **Diff:** 3 file(s), +12/-4
- **Engineer exit:** 0
- **Verification:** pass
- **Reviewer:** scope_ok

## alpha — c2

- **Outcome:** verification_failed
- **Reason:** test failed
- **SHA:** bbbbbbbb → cccccccc
- **Engineer exit:** 1
- **Verification:** fail
- **Reviewer:** skipped
`;

      it("emits null for --latest when no digests exist", async () => {
        const result = await runCli(["digest", "--latest", "--json"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("null");
      });

      it("emits [] for --list when no digests exist", async () => {
        const result = await runCli(["digest", "--list", "--json"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([]);
      });

      it("emits structured JSON for --latest", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260416_100000.md"), FULL_DIGEST);
        const result = await runCli(["digest", "--latest", "--json"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.file).toBe("digest_20260416_100000.md");
        expect(parsed.duration).toBe("5m");
        expect(parsed.cycle_count).toBe(2);
        expect(parsed.cycles).toHaveLength(2);
        expect(parsed.cycles[0]).toMatchObject({
          project_id: "alpha",
          cycle_id: "c1",
          outcome: "verified",
          sha_start: "aaaaaaaa",
          sha_end: "bbbbbbbb",
          diff_stats: { files_changed: 3, insertions: 12, deletions: 4 },
          engineer_exit: 0,
        });
        expect(parsed.cycles[1].outcome).toBe("verification_failed");
        expect(parsed.cycles[1].diff_stats).toBeNull();
      });

      it("emits JSON array for --list", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260415_120000.md"), FULL_DIGEST);
        writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), FULL_DIGEST);
        const result = await runCli(["digest", "--list", "--json"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].file).toBe("digest_20260416_090000.md");
        expect(parsed[0].cycles).toBe(2);
        expect(parsed[0].verified).toBe(1);
        expect(parsed[0].failed).toBe(1);
      });

      it("emits null for --date with no match", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260416_100000.md"), FULL_DIGEST);
        const result = await runCli(
          ["digest", "--date=20260101", "--json"],
          DIGEST_TEST_DIR,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("null");
      });
    });

    describe("--path", () => {
      it("prints absolute path of the latest digest", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260415_100000.md"), "OLD\n");
        writeFileSync(join(DIGEST_DIR, "digest_20260416_150000.md"), "NEW\n");
        const result = await runCli(["digest", "--latest", "--path"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        const out = result.stdout.trim();
        expect(out).toBe(join(DIGEST_DIR, "digest_20260416_150000.md"));
        expect(out).not.toContain("NEW");
      });

      it("prints clear message when digests dir is empty", async () => {
        const result = await runCli(["digest", "--latest", "--path"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("prints clear message when digests dir does not exist", async () => {
        rmSync(DIGEST_DIR, { recursive: true, force: true });
        const result = await runCli(["digest", "--latest", "--path"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("prints path for --date", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), "MORNING\n");
        writeFileSync(join(DIGEST_DIR, "digest_20260416_180000.md"), "EVENING\n");
        const result = await runCli(
          ["digest", "--date=20260416", "--path"],
          DIGEST_TEST_DIR,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(
          join(DIGEST_DIR, "digest_20260416_090000.md"),
        );
      });

      it("prints all paths newest-first with --list", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260415_120000.md"), "A\n");
        writeFileSync(join(DIGEST_DIR, "digest_20260416_090000.md"), "B\n");
        writeFileSync(join(DIGEST_DIR, "digest_20260416_180000.md"), "C\n");
        const result = await runCli(["digest", "--list", "--path"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        const lines = result.stdout.trim().split("\n");
        expect(lines).toEqual([
          join(DIGEST_DIR, "digest_20260416_180000.md"),
          join(DIGEST_DIR, "digest_20260416_090000.md"),
          join(DIGEST_DIR, "digest_20260415_120000.md"),
        ]);
      });

      it("--list --path prints clear message when empty", async () => {
        const result = await runCli(["digest", "--list", "--path"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("--latest --path --json emits JSON string", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260416_100000.md"), "X\n");
        const result = await runCli(
          ["digest", "--latest", "--path", "--json"],
          DIGEST_TEST_DIR,
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toBe(
          join(DIGEST_DIR, "digest_20260416_100000.md"),
        );
      });

      it("--list --path --json emits JSON array", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260415_120000.md"), "A\n");
        writeFileSync(join(DIGEST_DIR, "digest_20260416_180000.md"), "B\n");
        const result = await runCli(
          ["digest", "--list", "--path", "--json"],
          DIGEST_TEST_DIR,
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
          join(DIGEST_DIR, "digest_20260416_180000.md"),
          join(DIGEST_DIR, "digest_20260415_120000.md"),
        ]);
      });
    });
  });

  describe("summary --format=json", () => {
    const SUMMARY_TEST_DIR = join(import.meta.dir, "fixtures", "summary_json_test");

    function cycleEnd(opts: {
      project: string;
      cycleId: string;
      ts: string;
      outcome: string;
      durationSeconds?: number;
    }): string {
      return JSON.stringify({
        timestamp: opts.ts,
        event: "cycle_end",
        cycle_id: opts.cycleId,
        project_id: opts.project,
        data: {
          outcome: opts.outcome,
          duration_seconds: opts.durationSeconds ?? 60,
          start_sha: "aaa1111",
          end_sha: "bbb2222",
        },
      });
    }

    beforeEach(() => {
      const stateDir = join(SUMMARY_TEST_DIR, "state");
      mkdirSync(join(stateDir, "alpha"), { recursive: true });
      mkdirSync(join(stateDir, "beta"), { recursive: true });

      const alphaLog = [
        cycleEnd({ project: "alpha", cycleId: "c1", ts: "2026-04-16T10:00:00.000Z", outcome: "verified", durationSeconds: 120 }),
        cycleEnd({ project: "alpha", cycleId: "c2", ts: "2026-04-16T10:05:00.000Z", outcome: "verification_failed", durationSeconds: 30 }),
        cycleEnd({ project: "alpha", cycleId: "c3", ts: "2026-04-16T10:10:00.000Z", outcome: "cycle_skipped", durationSeconds: 5 }),
      ].join("\n") + "\n";
      const betaLog = [
        cycleEnd({ project: "beta", cycleId: "c4", ts: "2026-04-16T11:00:00.000Z", outcome: "verified", durationSeconds: 90 }),
      ].join("\n") + "\n";
      writeFileSync(join(stateDir, "alpha", "PROGRESS.jsonl"), alphaLog);
      writeFileSync(join(stateDir, "beta", "PROGRESS.jsonl"), betaLog);
    });

    afterEach(() => {
      rmSync(SUMMARY_TEST_DIR, { recursive: true, force: true });
    });

    it("outputs valid parseable JSON with summary/tests/disk keys", async () => {
      const result = await runCli(["summary", "--no-tests", "--format=json"], SUMMARY_TEST_DIR);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("summary");
      expect(parsed).toHaveProperty("tests");
      expect(parsed).toHaveProperty("disk");
      expect(parsed.tests).toBeNull();
      expect(parsed.summary.projects).toBe(2);
      expect(parsed.summary.cycles_total).toBe(4);
    });

    it("JSON counts match the text output's counts", async () => {
      const jsonResult = await runCli(
        ["summary", "--no-tests", "--format=json"],
        SUMMARY_TEST_DIR,
      );
      const textResult = await runCli(["summary", "--no-tests"], SUMMARY_TEST_DIR);
      expect(jsonResult.exitCode).toBe(0);
      expect(textResult.exitCode).toBe(0);

      const parsed = JSON.parse(jsonResult.stdout);
      const text = textResult.stdout;

      // Text contains e.g. "Total:         4"
      expect(text).toContain(`Total:         ${parsed.summary.cycles_total}`);
      expect(text).toContain(`Projects:        ${parsed.summary.projects}`);
      expect(text).toContain(
        `Verified:      ${parsed.summary.outcomes.verified}`,
      );
      expect(text).toContain(
        `Failed:        ${parsed.summary.outcomes.verification_failed}`,
      );
      expect(text).toContain(
        `Skipped:       ${parsed.summary.outcomes.cycle_skipped}`,
      );
    });

    it("rejects unknown --format value", async () => {
      const result = await runCli(
        ["summary", "--no-tests", "--format=yaml"],
        SUMMARY_TEST_DIR,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown --format");
    });

    it("without --format outputs formatted text (not JSON)", async () => {
      const result = await runCli(["summary", "--no-tests"], SUMMARY_TEST_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("=== GeneralStaff Fleet Summary ===");
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  describe("bot-status command", () => {
    const BS_TEST_DIR = join(import.meta.dir, "fixtures", "bot_status_test");

    async function initRepo(path: string) {
      mkdirSync(path, { recursive: true });
      await $`git -C ${path} init -b master`.quiet();
      await $`git -C ${path} config user.email test@example.com`.quiet();
      await $`git -C ${path} config user.name test`.quiet();
      await $`git -C ${path} config commit.gpgsign false`.quiet();
    }

    async function commitFile(path: string, file: string, content: string, msg: string) {
      writeFileSync(join(path, file), content, "utf8");
      await $`git -C ${path} add ${file}`.quiet();
      await $`git -C ${path} commit -m ${msg}`.quiet();
    }

    function writeProjectsYaml(dir: string, projects: { id: string; path: string }[]) {
      const body = projects
        .map(
          (p) => `  - id: ${p.id}
    path: ${p.path.replace(/\\/g, "/")}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md`,
        )
        .join("\n");
      writeFileSync(
        join(dir, "projects.yaml"),
        `projects:\n${body}\ndispatcher:\n  state_dir: ./state\n  fleet_state_file: ./fleet_state.json\n  stop_file: ./STOP\n  override_file: ./next_project.txt\n  picker: priority_x_staleness\n  max_cycles_per_project_per_session: 3\n  log_dir: ./logs\n  digest_dir: ./digests\n`,
      );
    }

    beforeEach(() => {
      mkdirSync(BS_TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(BS_TEST_DIR, { recursive: true, force: true });
    });

    it("prints 0 commits when bot/work has no ahead-commits", async () => {
      const repo = join(tmpdir(), "gs-bs-zero-" + Date.now());
      try {
        await initRepo(repo);
        await commitFile(repo, "a.txt", "one", "initial");
        await $`git -C ${repo} branch bot/work`.quiet();
        writeProjectsYaml(BS_TEST_DIR, [{ id: "alpha", path: repo }]);
        const result = await runCli(["bot-status"], BS_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("alpha: 0 commit(s) on bot/work not yet on master");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("counts commits on bot/work that are not yet on HEAD", async () => {
      const repo = join(tmpdir(), "gs-bs-ahead-" + Date.now());
      try {
        await initRepo(repo);
        await commitFile(repo, "a.txt", "one", "initial");
        await $`git -C ${repo} checkout -b bot/work`.quiet();
        await commitFile(repo, "b.txt", "two", "bot work 1");
        await commitFile(repo, "c.txt", "three", "bot work 2");
        await $`git -C ${repo} checkout master`.quiet();
        writeProjectsYaml(BS_TEST_DIR, [{ id: "alpha", path: repo }]);
        const result = await runCli(["bot-status"], BS_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("alpha: 2 commit(s) on bot/work not yet on master");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("filters by --project", async () => {
      const repoA = join(tmpdir(), "gs-bs-a-" + Date.now());
      const repoB = join(tmpdir(), "gs-bs-b-" + Date.now());
      try {
        await initRepo(repoA);
        await commitFile(repoA, "a.txt", "one", "initial");
        await $`git -C ${repoA} branch bot/work`.quiet();
        await initRepo(repoB);
        await commitFile(repoB, "a.txt", "one", "initial");
        await $`git -C ${repoB} branch bot/work`.quiet();
        writeProjectsYaml(BS_TEST_DIR, [
          { id: "alpha", path: repoA },
          { id: "beta", path: repoB },
        ]);
        const result = await runCli(["bot-status", "--project=beta"], BS_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("beta:");
        expect(result.stdout).not.toContain("alpha:");
      } finally {
        rmSync(repoA, { recursive: true, force: true });
        rmSync(repoB, { recursive: true, force: true });
      }
    });

    it("errors when --project doesn't match a registered id", async () => {
      const repo = join(tmpdir(), "gs-bs-nf-" + Date.now());
      try {
        await initRepo(repo);
        await commitFile(repo, "a.txt", "one", "initial");
        writeProjectsYaml(BS_TEST_DIR, [{ id: "alpha", path: repo }]);
        const result = await runCli(["bot-status", "--project=nonesuch"], BS_TEST_DIR);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("not found");
        expect(result.stderr).toContain("alpha");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("generalstaff bot-status");
    });
  });

  describe("stop --status / --check (gs-165)", () => {
    const STOP_STATUS_DIR = join(import.meta.dir, "fixtures", "stop_status_test");

    beforeEach(() => {
      mkdirSync(join(STOP_STATUS_DIR, "state"), { recursive: true });
    });

    afterEach(() => {
      rmSync(STOP_STATUS_DIR, { recursive: true, force: true });
    });

    it("reports STOP present + pid recorded", async () => {
      writeFileSync(join(STOP_STATUS_DIR, "STOP"), "");
      writeFileSync(join(STOP_STATUS_DIR, "state", "session.pid"), "12345\n");
      const result = await runCli(["stop", "--status"], STOP_STATUS_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/STOP file: present at .*STOP/);
      expect(result.stdout).toContain("Session pid: 12345");
    });

    it("reports STOP present + no pid file", async () => {
      writeFileSync(join(STOP_STATUS_DIR, "STOP"), "");
      const result = await runCli(["stop", "--status"], STOP_STATUS_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/STOP file: present at .*STOP/);
      expect(result.stdout).toContain("Session pid: none recorded");
    });

    it("reports STOP absent + pid recorded", async () => {
      writeFileSync(join(STOP_STATUS_DIR, "state", "session.pid"), "999\n");
      const result = await runCli(["stop", "--status"], STOP_STATUS_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("STOP file: absent");
      expect(result.stdout).toContain("Session pid: 999");
    });

    it("reports STOP absent + no pid file", async () => {
      const result = await runCli(["stop", "--status"], STOP_STATUS_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("STOP file: absent");
      expect(result.stdout).toContain("Session pid: none recorded");
    });

    it("accepts --check as an alias of --status", async () => {
      writeFileSync(join(STOP_STATUS_DIR, "STOP"), "");
      const result = await runCli(["stop", "--check"], STOP_STATUS_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/STOP file: present at .*STOP/);
      expect(result.stdout).toContain("Session pid: none recorded");
    });

    it("errors out when --status is combined with --force", async () => {
      const result = await runCli(
        ["stop", "--status", "--force"],
        STOP_STATUS_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--status/--check and --force are mutually exclusive",
      );
    });

    it("does not create or remove the STOP file", async () => {
      // STOP absent before: stays absent after
      const result1 = await runCli(["stop", "--status"], STOP_STATUS_DIR);
      expect(result1.exitCode).toBe(0);
      expect(existsSync(join(STOP_STATUS_DIR, "STOP"))).toBe(false);

      // STOP present before: stays present after
      writeFileSync(join(STOP_STATUS_DIR, "STOP"), "");
      const result2 = await runCli(["stop", "--status"], STOP_STATUS_DIR);
      expect(result2.exitCode).toBe(0);
      expect(existsSync(join(STOP_STATUS_DIR, "STOP"))).toBe(true);
    });

    it("is advertised in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.stdout).toContain("stop --status");
    });
  });

  describe("help completeness", () => {
    it("lists all registered commands in help output", async () => {
      const result = await runCli(["--help"]);
      const help = result.stdout;
      const expectedCommands = [
        "session", "cycle", "status", "stop", "start",
        "log", "projects", "init", "history", "doctor", "clean",
        "bot-status",
      ];
      for (const cmd of expectedCommands) {
        expect(help).toContain(`generalstaff ${cmd}`);
      }
    });
  });

  describe("status --backlog (gs-199)", () => {
    const BACKLOG_DIR = join(import.meta.dir, "fixtures", "status_backlog_test");
    const ALPHA_DIR = join(BACKLOG_DIR, "alpha");
    const BETA_DIR = join(BACKLOG_DIR, "beta");

    const PROJECTS_YAML = () => `
projects:
  - id: alpha
    path: ${ALPHA_DIR.replace(/\\/g, "/")}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    hands_off:
      - src/reviewer.ts
  - id: beta
    path: ${BETA_DIR.replace(/\\/g, "/")}
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    hands_off:
      - CLAUDE.md
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
      mkdirSync(join(ALPHA_DIR, "state", "alpha"), { recursive: true });
      mkdirSync(join(BETA_DIR, "state", "beta"), { recursive: true });
      writeFileSync(join(BACKLOG_DIR, "projects.yaml"), PROJECTS_YAML());
      // alpha: 2 bot-pickable, 1 interactive_only, 1 done
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "tasks.json"),
        JSON.stringify([
          { id: "a-1", title: "t1", status: "pending", priority: 1 },
          { id: "a-2", title: "t2", status: "pending", priority: 2 },
          { id: "a-3", title: "t3", status: "pending", priority: 2, interactive_only: true },
          { id: "a-4", title: "t4", status: "done", priority: 2 },
        ]),
      );
      // beta: 1 bot-pickable, 1 hands_off conflict (touches src/reviewer.ts
      // — not a hands_off path for beta, but CLAUDE.md is), 1 in_progress
      writeFileSync(
        join(BETA_DIR, "state", "beta", "tasks.json"),
        JSON.stringify([
          { id: "b-1", title: "t1", status: "pending", priority: 1 },
          {
            id: "b-2",
            title: "t2",
            status: "pending",
            priority: 2,
            expected_touches: ["CLAUDE.md"],
          },
          { id: "b-3", title: "t3", status: "in_progress", priority: 2 },
        ]),
      );
    });

    afterEach(() => {
      rmSync(BACKLOG_DIR, { recursive: true, force: true });
    });

    it("--json emits projects + totals in the expected shape", async () => {
      const result = await runCli(["status", "--backlog", "--json"], BACKLOG_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("projects");
      expect(parsed).toHaveProperty("totals");
      expect(parsed.projects).toHaveLength(2);
      const alpha = parsed.projects.find((p: { id: string }) => p.id === "alpha");
      expect(alpha).toEqual({
        id: "alpha",
        bot_pickable: 2,
        interactive_only: 1,
        handsoff_conflict: 0,
        in_progress: 0,
        done: 1,
      });
      const beta = parsed.projects.find((p: { id: string }) => p.id === "beta");
      expect(beta).toEqual({
        id: "beta",
        bot_pickable: 1,
        interactive_only: 0,
        handsoff_conflict: 1,
        in_progress: 1,
        done: 0,
      });
      expect(parsed.totals).toEqual({
        bot_pickable: 3,
        interactive_only: 1,
        handsoff_conflict: 1,
        in_progress: 1,
      });
    });

    it("rejects --backlog combined with --sessions", async () => {
      const result = await runCli(
        ["status", "--backlog", "--sessions"],
        BACKLOG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--backlog cannot be combined with --sessions/--summary/--watch",
      );
    });

    it("rejects --backlog combined with --summary", async () => {
      const result = await runCli(
        ["status", "--backlog", "--summary"],
        BACKLOG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--backlog cannot be combined with --sessions/--summary/--watch",
      );
    });
  });

  describe("status --totals (gs-202)", () => {
    const TOTALS_DIR = join(
      import.meta.dir,
      "fixtures",
      "status_totals_test",
    );

    const PROJECTS_YAML = `
projects:
  - id: alpha
    path: ${TOTALS_DIR.replace(/\\/g, "/")}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    hands_off: []
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
      mkdirSync(join(TOTALS_DIR, "state", "_fleet"), { recursive: true });
      writeFileSync(join(TOTALS_DIR, "projects.yaml"), PROJECTS_YAML);
    });

    afterEach(() => {
      rmSync(TOTALS_DIR, { recursive: true, force: true });
    });

    it("--totals --json emits zero totals for an empty history", async () => {
      const result = await runCli(["status", "--totals", "--json"], TOTALS_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        total_sessions: 0,
        total_cycles: 0,
        total_verified: 0,
        total_failed: 0,
        total_duration_hours: 0,
        parallel_sessions: 0,
        sequential_sessions: 0,
        weighted_avg_parallel_efficiency: null,
        first_seen: null,
        last_seen: null,
      });
    });

    it("--totals --json aggregates across recorded sessions", async () => {
      const logPath = join(TOTALS_DIR, "state", "_fleet", "PROGRESS.jsonl");
      const lines = [
        {
          timestamp: "2026-04-17T11:00:00.000Z",
          event: "session_complete",
          project_id: "_fleet",
          data: {
            duration_minutes: 60,
            total_cycles: 8,
            total_verified: 7,
            total_failed: 1,
            stop_reason: "budget",
            reviewer: "openrouter",
            max_parallel_slots: 2,
            parallel_rounds: 3,
            slot_idle_seconds: 30,
            parallel_efficiency: 0.8,
          },
        },
        {
          timestamp: "2026-04-17T12:30:00.000Z",
          event: "session_complete",
          project_id: "_fleet",
          data: {
            duration_minutes: 30,
            total_cycles: 3,
            total_verified: 3,
            total_failed: 0,
            stop_reason: "budget",
            reviewer: "claude",
          },
        },
        {
          timestamp: "2026-04-17T14:30:00.000Z",
          event: "session_complete",
          project_id: "_fleet",
          data: {
            duration_minutes: 30,
            total_cycles: 2,
            total_verified: 1,
            total_failed: 1,
            stop_reason: "max-cycles",
            reviewer: "claude",
          },
        },
      ];
      writeFileSync(
        logPath,
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      const result = await runCli(
        ["status", "--totals", "--json"],
        TOTALS_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.total_sessions).toBe(3);
      expect(parsed.total_cycles).toBe(13);
      expect(parsed.total_verified).toBe(11);
      expect(parsed.total_failed).toBe(2);
      expect(parsed.total_duration_hours).toBeCloseTo(2.0, 6);
      expect(parsed.parallel_sessions).toBe(1);
      expect(parsed.sequential_sessions).toBe(2);
      expect(parsed.weighted_avg_parallel_efficiency).toBeCloseTo(0.8, 6);
    });

    it("rejects --totals combined with --sessions", async () => {
      const result = await runCli(
        ["status", "--totals", "--sessions"],
        TOTALS_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--totals cannot be combined with --sessions/--summary/--backlog/--watch",
      );
    });

    it("rejects --totals combined with --summary", async () => {
      const result = await runCli(
        ["status", "--totals", "--summary"],
        TOTALS_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--totals cannot be combined with --sessions/--summary/--backlog/--watch",
      );
    });

    it("rejects --totals combined with --backlog", async () => {
      const result = await runCli(
        ["status", "--totals", "--backlog"],
        TOTALS_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--totals cannot be combined with --sessions/--summary/--backlog/--watch",
      );
    });
  });

  describe("status --fleet (gs-217)", () => {
    const FLEET_DIR = join(import.meta.dir, "fixtures", "status_fleet_test");
    const ALPHA_DIR = join(FLEET_DIR, "alpha");
    const BETA_DIR = join(FLEET_DIR, "beta");

    const PROJECTS_YAML = () => `
projects:
  - id: alpha
    path: ${ALPHA_DIR.replace(/\\/g, "/")}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    branch: bot/work
    auto_merge: true
    hands_off:
      - src/reviewer.ts
  - id: beta
    path: ${BETA_DIR.replace(/\\/g, "/")}
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    branch: main
    hands_off:
      - CLAUDE.md
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
      mkdirSync(join(ALPHA_DIR, "state", "alpha"), { recursive: true });
      mkdirSync(join(BETA_DIR, "state", "beta"), { recursive: true });
      writeFileSync(join(FLEET_DIR, "projects.yaml"), PROJECTS_YAML());
      // alpha: 2 bot-pickable tasks
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "tasks.json"),
        JSON.stringify([
          { id: "a-1", title: "t1", status: "pending", priority: 1 },
          { id: "a-2", title: "t2", status: "pending", priority: 2 },
        ]),
      );
      // beta: 1 bot-pickable task
      writeFileSync(
        join(BETA_DIR, "state", "beta", "tasks.json"),
        JSON.stringify([
          { id: "b-1", title: "t1", status: "pending", priority: 1 },
        ]),
      );
      // Fleet state with activity on alpha only
      writeFileSync(
        join(FLEET_DIR, "fleet_state.json"),
        JSON.stringify({
          version: 1,
          updated_at: "2026-04-18T12:00:00.000Z",
          projects: {
            alpha: {
              last_cycle_at: "2026-04-18T11:30:00.000Z",
              last_cycle_outcome: "verified",
              total_cycles: 4,
              total_verified: 3,
              total_failed: 1,
              accumulated_minutes: 25,
            },
          },
        }),
      );
    });

    afterEach(() => {
      rmSync(FLEET_DIR, { recursive: true, force: true });
    });

    it("renders 2 rows + TOTAL in the text table", async () => {
      const result = await runCli(["status", "--fleet"], FLEET_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("alpha");
      expect(result.stdout).toContain("beta");
      expect(result.stdout).toContain("TOTAL");
      expect(result.stdout).toContain("bot/work");
      expect(result.stdout).toContain("main");
      expect(result.stdout).toContain("never"); // beta has no state
    });

    it("--json emits projects + totals in the expected shape", async () => {
      const result = await runCli(["status", "--fleet", "--json"], FLEET_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("projects");
      expect(parsed).toHaveProperty("totals");
      expect(parsed.projects).toHaveLength(2);
      const alpha = parsed.projects.find((p: { id: string }) => p.id === "alpha");
      expect(alpha).toEqual({
        id: "alpha",
        last_cycle_at: "2026-04-18T11:30:00.000Z",
        total_cycles: 4,
        total_verified: 3,
        total_failed: 1,
        bot_pickable: 2,
        auto_merge: true,
        branch: "bot/work",
      });
      const beta = parsed.projects.find((p: { id: string }) => p.id === "beta");
      expect(beta).toEqual({
        id: "beta",
        last_cycle_at: null,
        total_cycles: 0,
        total_verified: 0,
        total_failed: 0,
        bot_pickable: 1,
        auto_merge: false,
        branch: "main",
      });
      expect(parsed.totals).toEqual({
        total_cycles: 4,
        total_verified: 3,
        total_failed: 1,
        bot_pickable: 3,
      });
    });

    it("rejects --fleet combined with --sessions", async () => {
      const result = await runCli(
        ["status", "--fleet", "--sessions"],
        FLEET_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--fleet cannot be combined with --sessions/--summary/--backlog/--totals/--watch",
      );
    });

    it("rejects --fleet combined with --summary", async () => {
      const result = await runCli(
        ["status", "--fleet", "--summary"],
        FLEET_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--fleet cannot be combined with --sessions/--summary/--backlog/--totals/--watch",
      );
    });

    it("rejects --fleet combined with --backlog", async () => {
      const result = await runCli(
        ["status", "--fleet", "--backlog"],
        FLEET_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--fleet cannot be combined with --sessions/--summary/--backlog/--totals/--watch",
      );
    });

    it("rejects --fleet combined with --totals", async () => {
      const result = await runCli(
        ["status", "--fleet", "--totals"],
        FLEET_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--fleet cannot be combined with --sessions/--summary/--backlog/--totals/--watch",
      );
    });
  });

  describe("diff subcommand (gs-207)", () => {
    const DIFF_TEST_DIR = join(import.meta.dir, "fixtures", "diff_cmd_test");

    const PROJECTS_YAML = `
projects:
  - id: alpha
    path: /tmp/generalstaff_test_diff_alpha_nonexistent
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    hands_off:
      - CLAUDE.md
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

    const SAMPLE_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
-old line
+new line
+added line
 line3
diff --git a/src/bar.ts b/src/bar.ts
index 111..222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,1 @@
-removed
 kept
`;

    beforeEach(() => {
      mkdirSync(join(DIFF_TEST_DIR, "state", "alpha", "cycles", "cyc-001"), {
        recursive: true,
      });
      mkdirSync(join(DIFF_TEST_DIR, "state", "alpha", "cycles", "cyc-002"), {
        recursive: true,
      });
      mkdirSync(join(DIFF_TEST_DIR, "state", "alpha", "cycles", "cyc-003"), {
        recursive: true,
      });
      writeFileSync(join(DIFF_TEST_DIR, "projects.yaml"), PROJECTS_YAML);
      writeFileSync(
        join(DIFF_TEST_DIR, "state", "alpha", "cycles", "cyc-001", "diff.patch"),
        SAMPLE_PATCH,
      );
      // cyc-002 has an empty diff.patch
      writeFileSync(
        join(DIFF_TEST_DIR, "state", "alpha", "cycles", "cyc-002", "diff.patch"),
        "",
      );
      // cyc-003 has no diff.patch at all
    });

    afterEach(() => {
      rmSync(DIFF_TEST_DIR, { recursive: true, force: true });
    });

    it("prints the full patch to stdout without --stat", async () => {
      const result = await runCli(
        ["diff", "alpha", "cyc-001"],
        DIFF_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("diff --git a/src/foo.ts b/src/foo.ts");
      expect(result.stdout).toContain("+new line");
      expect(result.stdout).toContain("-old line");
      expect(result.stdout).toContain("diff --git a/src/bar.ts b/src/bar.ts");
    });

    it("prints a --stat summary", async () => {
      const result = await runCli(
        ["diff", "alpha", "cyc-001", "--stat"],
        DIFF_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("src/foo.ts");
      expect(result.stdout).toContain("src/bar.ts");
      // foo.ts: 2 insertions, 1 deletion
      expect(result.stdout).toMatch(/src\/foo\.ts\s*\|\s*3\s*\+\++-/);
      // bar.ts: 0 insertions, 1 deletion
      expect(result.stdout).toMatch(/src\/bar\.ts\s*\|\s*1\s*-/);
      // totals line
      expect(result.stdout).toContain(
        "2 files changed, 2 insertions(+), 2 deletions(-)",
      );
      // raw diff headers absent
      expect(result.stdout).not.toContain("@@");
    });

    it("errors with registered-projects hint when project is unknown", async () => {
      const result = await runCli(
        ["diff", "bogus", "cyc-001"],
        DIFF_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error: project 'bogus' not found");
      expect(result.stderr).toContain("Registered: alpha");
    });

    it("errors with recent cycle ids when cycle dir is missing", async () => {
      const result = await runCli(
        ["diff", "alpha", "cyc-missing"],
        DIFF_TEST_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: cycle 'cyc-missing' not found under project 'alpha'",
      );
      expect(result.stderr).toContain("Recent cycle ids:");
      expect(result.stderr).toContain("cyc-003");
      expect(result.stderr).toContain("cyc-002");
      expect(result.stderr).toContain("cyc-001");
    });

    it("prints a friendly message when diff.patch is absent", async () => {
      const result = await runCli(
        ["diff", "alpha", "cyc-003"],
        DIFF_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(no diff captured for this cycle)");
    });

    it("prints a friendly message when diff.patch is empty", async () => {
      const result = await runCli(
        ["diff", "alpha", "cyc-002"],
        DIFF_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(no diff captured for this cycle)");
    });

    it("errors when positional args are missing", async () => {
      const result = await runCli(["diff", "alpha"], DIFF_TEST_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "project-id and cycle-id are required",
      );
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "generalstaff diff <project-id> <cycle-id>",
      );
    });
  });

  describe("view subcommand (gs-226)", () => {
    const VIEW_DIR = join(import.meta.dir, "fixtures", "view_gs226_test");
    const ALPHA_DIR = join(VIEW_DIR, "alpha");
    const BETA_DIR = join(VIEW_DIR, "beta");

    const PROJECTS_YAML = () => `
projects:
  - id: alpha
    path: ${ALPHA_DIR.replace(/\\/g, "/")}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    branch: bot/work
    auto_merge: true
    hands_off:
      - src/reviewer.ts
  - id: beta
    path: ${BETA_DIR.replace(/\\/g, "/")}
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    work_detection: tasks_json
    branch: main
    auto_merge: false
    hands_off:
      - CLAUDE.md
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
      mkdirSync(join(ALPHA_DIR, "state", "alpha"), { recursive: true });
      mkdirSync(join(BETA_DIR, "state", "beta"), { recursive: true });
      writeFileSync(join(VIEW_DIR, "projects.yaml"), PROJECTS_YAML());
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "tasks.json"),
        JSON.stringify([
          { id: "a-1", title: "t1", status: "pending", priority: 1 },
          { id: "a-2", title: "t2", status: "pending", priority: 2 },
        ]),
      );
      writeFileSync(
        join(BETA_DIR, "state", "beta", "tasks.json"),
        JSON.stringify([
          { id: "b-1", title: "t1", status: "pending", priority: 1 },
        ]),
      );
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "STATE.json"),
        JSON.stringify({
          project_id: "alpha",
          current_cycle_id: null,
          last_cycle_id: "c1",
          last_cycle_at: "2026-04-18T11:30:00.000Z",
          last_cycle_outcome: "verified",
          cycles_this_session: 0,
        }),
      );
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "PROGRESS.jsonl"),
        [
          {
            timestamp: "2026-04-18T10:00:00Z",
            event: "cycle_end",
            cycle_id: "c1",
            project_id: "alpha",
            data: { outcome: "verified" },
          },
          {
            timestamp: "2026-04-18T10:05:00Z",
            event: "cycle_end",
            cycle_id: "c2",
            project_id: "alpha",
            data: { outcome: "verified" },
          },
          {
            timestamp: "2026-04-18T10:10:00Z",
            event: "cycle_end",
            cycle_id: "c3",
            project_id: "alpha",
            data: { outcome: "verification_failed" },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
    });

    afterEach(() => {
      rmSync(VIEW_DIR, { recursive: true, force: true });
    });

    it("view fleet-overview --json emits FleetOverviewData shape", async () => {
      const result = await runCli(
        ["view", "fleet-overview", "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("projects");
      expect(parsed).toHaveProperty("aggregates");
      expect(parsed).toHaveProperty("rendered_at");
      expect(Array.isArray(parsed.projects)).toBe(true);
      expect(parsed.projects).toHaveLength(2);
      const alpha = parsed.projects.find((p: { id: string }) => p.id === "alpha");
      expect(alpha.cycles_total).toBe(3);
      expect(alpha.verified).toBe(2);
      expect(alpha.failed).toBe(1);
      expect(alpha.branch).toBe("bot/work");
      expect(alpha.auto_merge).toBe(true);
      expect(parsed.aggregates.project_count).toBe(2);
      expect(parsed.aggregates.total_cycles).toBe(3);
    });

    it("view with no sub-view prints usage and exits 1", async () => {
      const result = await runCli(["view"], VIEW_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage: generalstaff view <name>");
      expect(result.stderr).toContain("fleet-overview");
      expect(result.stderr).toContain("task-queue");
      expect(result.stderr).toContain("session-tail");
      expect(result.stderr).toContain("dispatch-detail");
      expect(result.stderr).toContain("inbox");
    });

    it("view unknown-name prints the valid-views list and exits 1", async () => {
      const result = await runCli(["view", "unknown-name"], VIEW_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: unknown view 'unknown-name'. Valid views: fleet-overview, task-queue, session-tail, dispatch-detail, inbox",
      );
    });

    it("view fleet-overview table includes all registered projects as rows", async () => {
      const result = await runCli(["view", "fleet-overview"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("alpha");
      expect(result.stdout).toContain("beta");
      expect(result.stdout).toContain("bot/work");
      expect(result.stdout).toContain("main");
      // beta has no PROGRESS.jsonl / STATE.json, so last_cycle is "never"
      expect(result.stdout).toContain("never");
    });

    it("view fleet-overview aggregates line renders pass_rate as a percentage", async () => {
      const result = await runCli(["view", "fleet-overview"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      // 2 verified / 3 (2 verified + 1 failed) = 67%
      expect(result.stdout).toMatch(/pass_rate:\s*67%/);
      expect(result.stdout).toContain("Total cycles: 3");
      expect(result.stdout).toContain("slot_efficiency_recent: n/a");
    });

    it("is listed in --help output", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff view <name>");
    });
  });
});
