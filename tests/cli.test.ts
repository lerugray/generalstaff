import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
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

  describe("subcommand --help (gs-244)", () => {
    it("session --help prints session-specific usage and exits 0", async () => {
      const result = await runCli(["session", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff session");
      expect(result.stdout).toContain("--budget");
      expect(result.stdout).toContain("--chain");
      expect(result.stdout).toContain("--verbose");
    });

    it("session without --help still validates flags normally", async () => {
      // Confirms the help-guard does not swallow real args — --chain=0 still errors.
      const result = await runCli(["session", "--chain=0"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--chain must be a positive integer");
    });

    it("cycle --help prints cycle-specific usage and exits 0", async () => {
      const result = await runCli(["cycle", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff cycle");
      expect(result.stdout).toContain("--project");
      expect(result.stdout).toContain("--dry-run");
    });

    it("cycle without --help still requires --project", async () => {
      const result = await runCli(["cycle"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--project=<id> is required");
    });

    it("status --help prints status-specific usage and exits 0", async () => {
      const result = await runCli(["status", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff status");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("--sessions");
      expect(result.stdout).toContain("--fleet");
    });

    it("status without --help rejects conflicting subview flags", async () => {
      // Existing behavior preserved: mutually-exclusive subview flags still error.
      const result = await runCli(["status", "--backlog", "--summary"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--backlog cannot be combined with --sessions/--summary/--watch",
      );
    });

    it("task --help prints task-specific usage and exits 0", async () => {
      const result = await runCli(["task", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff task");
      expect(result.stdout).toContain("list");
      expect(result.stdout).toContain("add");
      expect(result.stdout).toContain("done");
      expect(result.stdout).toContain("interactive");
    });

    it("task help (positional) prints task-specific usage and exits 0", async () => {
      const result = await runCli(["task", "help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff task");
      expect(result.stdout).toContain("interactive");
    });

    it("task without --help still requires a subcommand", async () => {
      const result = await runCli(["task"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task subcommand required");
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

    // gs-245: --no-color is a global flag, stripped before per-subcommand
    // parseArgs runs. This guards against a regression where adding --no-color
    // to a subcommand call would trip parseArgs's strict-mode rejection.
    it("accepts --no-color without erroring on the history subcommand", async () => {
      const result = await runCli(
        ["history", "--no-color"],
        HISTORY_TEST_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CYCLE");
      // Pipe-mode subprocess output already strips color; the meaningful
      // assertion is "no escape sequences leaked through" and "no parse error".
      expect(result.stdout).not.toContain("\x1b[");
    });
  });

  // gs-245: NO_COLOR (no-color.org) and --no-color must never produce ANSI
  // escapes in CLI output. The runCli subprocess pipes stdout (non-TTY) so
  // color is already off by default; these tests are belt-and-braces for
  // regressions where someone unconditionally emits escape sequences.
  describe("--no-color and NO_COLOR env", () => {
    it("--help mentions --no-color", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--no-color");
    });

    it("NO_COLOR=1 env keeps the CLI from emitting ANSI escapes", async () => {
      const proc = Bun.spawn(["bun", "run", CLI_PATH, "--help"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("\x1b[");
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

    describe("last subcommand", () => {
      it("prints most recent digest contents (by mtime)", async () => {
        const oldPath = join(DIGEST_DIR, "digest_20260415_100000.md");
        const newPath = join(DIGEST_DIR, "digest_20260416_150000.md");
        writeFileSync(oldPath, "OLD\n");
        writeFileSync(newPath, "NEWEST\n");
        utimesSync(oldPath, new Date("2026-04-15T10:00:00Z"), new Date("2026-04-15T10:00:00Z"));
        utimesSync(newPath, new Date("2026-04-16T15:00:00Z"), new Date("2026-04-16T15:00:00Z"));
        const result = await runCli(["digest", "last"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("NEWEST");
        expect(result.stdout).not.toContain("OLD");
      });

      it("prints friendly message when digests dir is empty", async () => {
        const result = await runCli(["digest", "last"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("prints friendly message when digests dir does not exist", async () => {
        rmSync(DIGEST_DIR, { recursive: true, force: true });
        const result = await runCli(["digest", "last"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No digests found");
      });

      it("--json emits object with path, content, and timestamp", async () => {
        writeFileSync(join(DIGEST_DIR, "digest_20260416_150000.md"), "HELLO\n");
        const result = await runCli(["digest", "last", "--json"], DIGEST_TEST_DIR);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.path).toContain("digest_20260416_150000.md");
        expect(parsed.content).toBe("HELLO\n");
        expect(typeof parsed.timestamp).toBe("string");
        expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
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

    // gs-234: friendly "queues drained" note surfaces the empty-fleet
    // state in text mode so the operator sees a seed prompt instead of
    // a silent row of zeros.
    it("text mode appends the 'queues drained' note when every project has 0 bot-pickable work", async () => {
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "tasks.json"),
        JSON.stringify([
          { id: "a-1", title: "t1", status: "done", priority: 1 },
          { id: "a-2", title: "t2", status: "pending", priority: 2, interactive_only: true },
        ]),
      );
      writeFileSync(
        join(BETA_DIR, "state", "beta", "tasks.json"),
        JSON.stringify([
          { id: "b-1", title: "t1", status: "in_progress", priority: 1 },
        ]),
      );
      const result = await runCli(["status", "--backlog"], BACKLOG_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "All queues drained. Seed tasks with `generalstaff tasks add <project-id> --title=... --priority=N` or directly in `state/<project-id>/tasks.json`.",
      );
    });

    it("text mode omits the 'queues drained' note when at least one project has bot-pickable work", async () => {
      const result = await runCli(["status", "--backlog"], BACKLOG_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("All queues drained");
    });

    it("--json never emits the friendly note, even when every project is drained", async () => {
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "tasks.json"),
        JSON.stringify([]),
      );
      writeFileSync(
        join(BETA_DIR, "state", "beta", "tasks.json"),
        JSON.stringify([]),
      );
      const result = await runCli(
        ["status", "--backlog", "--json"],
        BACKLOG_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("All queues drained");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.totals.bot_pickable).toBe(0);
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

    it("view with no sub-view prints usage to stdout and exits 0 (gs-233)", async () => {
      const result = await runCli(["view"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff view <name>");
      expect(result.stdout).toContain("fleet-overview");
      expect(result.stdout).toContain("task-queue");
      expect(result.stdout).toContain("session-tail");
      expect(result.stdout).toContain("dispatch-detail");
      expect(result.stdout).toContain("inbox");
    });

    it("view --help prints usage to stdout and exits 0 (gs-233)", async () => {
      const result = await runCli(["view", "--help"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff view <name>");
      expect(result.stdout).toContain("fleet-overview");
      expect(result.stdout).toContain("task-queue");
      expect(result.stdout).toContain("session-tail");
      expect(result.stdout).toContain("dispatch-detail");
      expect(result.stdout).toContain("inbox");
    });

    it("view help prints usage to stdout and exits 0 (gs-233)", async () => {
      const result = await runCli(["view", "help"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: generalstaff view <name>");
      expect(result.stdout).toContain("fleet-overview");
      expect(result.stdout).toContain("task-queue");
      expect(result.stdout).toContain("session-tail");
      expect(result.stdout).toContain("dispatch-detail");
      expect(result.stdout).toContain("inbox");
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

  describe("view task-queue subcommand (gs-227)", () => {
    const VIEW_DIR = join(import.meta.dir, "fixtures", "view_taskqueue_test");
    const ALPHA_DIR = join(VIEW_DIR, "alpha");
    const EMPTY_DIR = join(VIEW_DIR, "empty");

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
  - id: empty
    path: ${EMPTY_DIR.replace(/\\/g, "/")}
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
      mkdirSync(join(EMPTY_DIR, "state", "empty"), { recursive: true });
      writeFileSync(join(VIEW_DIR, "projects.yaml"), PROJECTS_YAML());
      writeFileSync(
        join(ALPHA_DIR, "state", "alpha", "tasks.json"),
        JSON.stringify([
          {
            id: "a-1",
            title: "in-flight task",
            status: "in_progress",
            priority: 1,
          },
          {
            id: "a-2",
            title: "ready pickable task",
            status: "pending",
            priority: 2,
          },
          {
            id: "a-3",
            title: "interactive blocked task",
            status: "pending",
            priority: 3,
            interactive_only: true,
          },
          {
            id: "a-4",
            title: "hands-off blocked task",
            status: "pending",
            priority: 4,
            expected_touches: ["src/reviewer.ts"],
          },
          {
            id: "a-5",
            title: "done long ago task",
            status: "done",
            priority: 5,
            completed_at: "2026-04-17T10:00:00.000Z",
          },
        ]),
      );
      writeFileSync(
        join(EMPTY_DIR, "state", "empty", "tasks.json"),
        JSON.stringify([]),
      );
    });

    afterEach(() => {
      rmSync(VIEW_DIR, { recursive: true, force: true });
    });

    it("--json emits TaskQueueData shape with four buckets", async () => {
      const result = await runCli(
        ["view", "task-queue", "alpha", "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.project_id).toBe("alpha");
      expect(Array.isArray(parsed.in_flight)).toBe(true);
      expect(Array.isArray(parsed.ready)).toBe(true);
      expect(Array.isArray(parsed.blocked)).toBe(true);
      expect(Array.isArray(parsed.shipped)).toBe(true);
      expect(parsed.in_flight).toHaveLength(1);
      expect(parsed.ready).toHaveLength(1);
      expect(parsed.blocked).toHaveLength(2);
      expect(parsed.shipped).toHaveLength(1);
      const blockedA3 = parsed.blocked.find(
        (e: { id: string }) => e.id === "a-3",
      );
      expect(blockedA3.block_reason).toBe("interactive_only");
      const blockedA4 = parsed.blocked.find(
        (e: { id: string }) => e.id === "a-4",
      );
      expect(blockedA4.block_reason).toBe("hands_off_intersect");
    });

    it("missing project-id arg errors and exits 1", async () => {
      const result = await runCli(["view", "task-queue"], VIEW_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: view task-queue requires <project-id>",
      );
    });

    it("unknown project-id surfaces TaskQueueError and exits 1", async () => {
      const result = await runCli(
        ["view", "task-queue", "nonesuch"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown project: nonesuch");
    });

    it("renders four labeled sections with per-task info", async () => {
      const result = await runCli(["view", "task-queue", "alpha"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("In-flight:");
      expect(result.stdout).toContain("Ready:");
      expect(result.stdout).toContain("Blocked:");
      expect(result.stdout).toContain("Shipped:");
      expect(result.stdout).toContain("a-1");
      expect(result.stdout).toContain("a-2");
      expect(result.stdout).toContain("a-3");
      expect(result.stdout).toContain("[P2]");
      expect(result.stdout).toContain("block: interactive_only");
      expect(result.stdout).toContain("block: hands_off_intersect");
    });

    it("renders empty buckets as (none) for a project with no tasks", async () => {
      const result = await runCli(["view", "task-queue", "empty"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("In-flight: (none)");
      expect(result.stdout).toContain("Ready: (none)");
      expect(result.stdout).toContain("Blocked: (none)");
      expect(result.stdout).toContain("Shipped: (none)");
    });
  });

  describe("view session-tail subcommand (gs-228)", () => {
    const VIEW_DIR = join(
      import.meta.dir,
      "fixtures",
      "view_session_tail_test",
    );
    const FLEET_DIR = join(VIEW_DIR, "state", "_fleet");

    const buildLog = (numSessions: number): string => {
      const events: Array<Record<string, unknown>> = [];
      for (let i = 0; i < numSessions; i++) {
        const sessionId = `sess-${String(i).padStart(2, "0")}`;
        // older sessions have earlier start times
        const hour = String(10 + i).padStart(2, "0");
        events.push({
          timestamp: `2026-04-18T${hour}:00:00Z`,
          event: "session_start",
          data: { session_id: sessionId, budget_minutes: 30 },
        });
        events.push({
          timestamp: `2026-04-18T${hour}:01:00Z`,
          event: "cycle_start",
          cycle_id: `c-${sessionId}`,
          project_id: "generalstaff",
          data: {
            session_id: sessionId,
            task_id: `gs-${i + 100}`,
            sha_before: "aaa",
          },
        });
        events.push({
          timestamp: `2026-04-18T${hour}:02:00Z`,
          event: "cycle_end",
          cycle_id: `c-${sessionId}`,
          project_id: "generalstaff",
          data: {
            session_id: sessionId,
            outcome: "verified",
            duration_seconds: 60,
            files_touched: ["src/foo.ts"],
            diff_stats: { additions: 5, deletions: 1 },
          },
        });
        events.push({
          timestamp: `2026-04-18T${hour}:10:00Z`,
          event: "session_end",
          data: {
            session_id: sessionId,
            duration_minutes: 10,
            stop_reason: "max-cycles",
            reviewer: "openrouter",
          },
        });
      }
      return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    };

    beforeEach(() => {
      mkdirSync(FLEET_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(VIEW_DIR, { recursive: true, force: true });
    });

    it("--json emits SessionTailData shape", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog(2));
      const result = await runCli(
        ["view", "session-tail", "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("sessions");
      expect(parsed).toHaveProperty("earlier_rail");
      expect(parsed).toHaveProperty("rendered_at");
      expect(Array.isArray(parsed.sessions)).toBe(true);
      expect(parsed.sessions).toHaveLength(2);
      // newest-first
      expect(parsed.sessions[0].session_id).toBe("sess-01");
      expect(parsed.sessions[1].session_id).toBe("sess-00");
      expect(parsed.sessions[0].cycles).toHaveLength(1);
      expect(parsed.sessions[0].cycles[0].verdict).toBe("verified");
    });

    it("default limit renders 3 sessions (newest first)", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog(5));
      const result = await runCli(
        ["view", "session-tail", "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.sessions).toHaveLength(3);
      expect(parsed.sessions[0].session_id).toBe("sess-04");
      expect(parsed.sessions[1].session_id).toBe("sess-03");
      expect(parsed.sessions[2].session_id).toBe("sess-02");
      // older sessions show up in earlier_rail
      expect(parsed.earlier_rail.length).toBeGreaterThanOrEqual(2);
    });

    it("--limit=5 honored", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog(6));
      const result = await runCli(
        ["view", "session-tail", "--limit=5", "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.sessions).toHaveLength(5);
    });

    it("invalid --limit errors and exits 1", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog(2));
      const resultZero = await runCli(
        ["view", "session-tail", "--limit=0"],
        VIEW_DIR,
      );
      expect(resultZero.exitCode).toBe(1);
      expect(resultZero.stderr).toContain(
        "Error: --limit must be a positive integer",
      );

      const resultNeg = await runCli(
        ["view", "session-tail", "--limit=-1"],
        VIEW_DIR,
      );
      expect(resultNeg.exitCode).toBe(1);
      expect(resultNeg.stderr).toContain(
        "Error: --limit must be a positive integer",
      );

      const resultText = await runCli(
        ["view", "session-tail", "--limit=abc"],
        VIEW_DIR,
      );
      expect(resultText.exitCode).toBe(1);
      expect(resultText.stderr).toContain(
        "Error: --limit must be a positive integer",
      );
    });

    it("empty PROGRESS.jsonl renders 'No sessions yet' friendly message", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), "");
      const result = await runCli(["view", "session-tail"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No sessions yet");
    });

    it("text render includes session header fields and per-cycle line", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog(1));
      const result = await runCli(["view", "session-tail"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Session: sess-00");
      expect(result.stdout).toContain("duration_minutes: 10");
      expect(result.stdout).toContain("reviewer:");
      expect(result.stdout).toContain("openrouter");
      expect(result.stdout).toContain("stop_reason:");
      expect(result.stdout).toContain("max-cycles");
      expect(result.stdout).toContain("c-sess-00");
      expect(result.stdout).toContain("gs-100");
      expect(result.stdout).toContain("generalstaff");
      expect(result.stdout).toContain("60s");
      expect(result.stdout).toContain("verified");
    });
  });

  describe("view dispatch-detail subcommand (gs-229)", () => {
    const VIEW_DIR = join(
      import.meta.dir,
      "fixtures",
      "view_dispatch_detail_test",
    );
    const FLEET_DIR = join(VIEW_DIR, "state", "_fleet");

    const buildLog = (cycleId: string): string => {
      const events: Array<Record<string, unknown>> = [
        {
          timestamp: "2026-04-18T10:00:00Z",
          event: "cycle_start",
          cycle_id: cycleId,
          project_id: "alpha",
          data: { task_id: "a-1", session_id: "sess-01", sha_before: "aaa" },
        },
        {
          timestamp: "2026-04-18T10:00:05Z",
          event: "engineer_start",
          cycle_id: cycleId,
          project_id: "alpha",
          data: { session_id: "sess-01", command: "claude -p" },
        },
        {
          timestamp: "2026-04-18T10:01:05Z",
          event: "engineer_end",
          cycle_id: cycleId,
          project_id: "alpha",
          data: { session_id: "sess-01", duration_seconds: 60 },
        },
        {
          timestamp: "2026-04-18T10:01:10Z",
          event: "verification_start",
          cycle_id: cycleId,
          project_id: "alpha",
          data: { session_id: "sess-01", command: "bun test" },
        },
        {
          timestamp: "2026-04-18T10:01:40Z",
          event: "verification_end",
          cycle_id: cycleId,
          project_id: "alpha",
          data: {
            session_id: "sess-01",
            duration_seconds: 30,
            outcome: "pass",
          },
        },
        {
          timestamp: "2026-04-18T10:01:45Z",
          event: "reviewer_start",
          cycle_id: cycleId,
          project_id: "alpha",
          data: { session_id: "sess-01" },
        },
        {
          timestamp: "2026-04-18T10:02:00Z",
          event: "reviewer_end",
          cycle_id: cycleId,
          project_id: "alpha",
          data: {
            session_id: "sess-01",
            duration_seconds: 15,
            verdict: "verified",
            scope_drift_files: [],
            hands_off_violations: [],
            silent_failures: [],
          },
        },
        {
          timestamp: "2026-04-18T10:02:05Z",
          event: "cycle_end",
          cycle_id: cycleId,
          project_id: "alpha",
          data: {
            session_id: "sess-01",
            task_id: "a-1",
            outcome: "verified",
            duration_seconds: 125,
            sha_after: "bbb",
            files_touched: [
              { path: "src/foo.ts", added: 5, removed: 1 },
              { path: "tests/foo.test.ts", added: 10, removed: 0 },
            ],
            diff_stats: { additions: 15, deletions: 1 },
          },
        },
      ];
      return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    };

    beforeEach(() => {
      mkdirSync(FLEET_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(VIEW_DIR, { recursive: true, force: true });
    });

    it("--json emits DispatchDetailData shape", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog("cyc-001"));
      const result = await runCli(
        ["view", "dispatch-detail", "cyc-001", "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.cycle_id).toBe("cyc-001");
      expect(parsed.task_id).toBe("a-1");
      expect(parsed.project_id).toBe("alpha");
      expect(parsed.verdict).toBe("verified");
      expect(parsed.duration_seconds).toBe(125);
      expect(parsed).toHaveProperty("engineer");
      expect(parsed).toHaveProperty("verification");
      expect(parsed).toHaveProperty("review");
      expect(parsed.engineer.duration_seconds).toBe(60);
      expect(parsed.verification.duration_seconds).toBe(30);
      expect(parsed.review.duration_seconds).toBe(15);
      expect(parsed.diff_added).toBe(15);
      expect(parsed.diff_removed).toBe(1);
      expect(Array.isArray(parsed.files_touched)).toBe(true);
      expect(parsed.files_touched).toHaveLength(2);
      expect(Array.isArray(parsed.checks)).toBe(true);
      expect(parsed.checks).toHaveLength(3);
    });

    it("missing cycle-id errors and exits 1", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog("cyc-001"));
      const result = await runCli(["view", "dispatch-detail"], VIEW_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: view dispatch-detail requires <cycle-id>",
      );
    });

    it("unknown cycle-id errors and exits 1", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog("cyc-001"));
      const result = await runCli(
        ["view", "dispatch-detail", "cyc-does-not-exist"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error: cycle not found: cyc-does-not-exist");
    });

    it("phase durations render as integers", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog("cyc-001"));
      const result = await runCli(
        ["view", "dispatch-detail", "cyc-001"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("engineer");
      expect(result.stdout).toContain("60s");
      expect(result.stdout).toContain("verification");
      expect(result.stdout).toContain("30s");
      expect(result.stdout).toContain("review");
      expect(result.stdout).toContain("15s");
      // no decimals — rendered as integers
      expect(result.stdout).not.toMatch(/\d+\.\d+s/);
    });

    it("files_touched renders with +/- markers", async () => {
      writeFileSync(join(FLEET_DIR, "PROGRESS.jsonl"), buildLog("cyc-001"));
      const result = await runCli(
        ["view", "dispatch-detail", "cyc-001"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Files touched:");
      expect(result.stdout).toContain("+5/-1");
      expect(result.stdout).toContain("src/foo.ts");
      expect(result.stdout).toContain("+10/-0");
      expect(result.stdout).toContain("tests/foo.test.ts");
      // aggregate diff line
      expect(result.stdout).toContain("Diff: +15/-1");
    });
  });

  describe("view inbox subcommand (gs-230)", () => {
    const VIEW_DIR = join(import.meta.dir, "fixtures", "view_inbox_test");
    const FLEET_DIR = join(VIEW_DIR, "state", "_fleet");

    const isoDaysAgo = (days: number): string =>
      new Date(Date.now() - days * 86_400_000).toISOString();

    const writeMessages = (msgs: Array<Record<string, unknown>>) => {
      const body = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(join(FLEET_DIR, "messages.jsonl"), body);
    };

    beforeEach(() => {
      mkdirSync(FLEET_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(VIEW_DIR, { recursive: true, force: true });
    });

    it("--json emits the full InboxData shape", async () => {
      writeMessages([
        {
          timestamp: isoDaysAgo(1),
          from: "generalstaff-bot",
          body: "shipped gs-230",
          kind: "fyi",
          refs: [{ session_id: "sess-1", task_id: "gs-230" }],
        },
        {
          timestamp: isoDaysAgo(2),
          from: "ray",
          body: "nice work",
        },
      ]);
      const result = await runCli(["view", "inbox", "--json"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed.groups)).toBe(true);
      expect(parsed.unread_count).toBe(2);
      expect(typeof parsed.oldest_shown).toBe("string");
      expect(typeof parsed.rendered_at).toBe("string");
      expect(parsed.groups.length).toBeGreaterThan(0);
      const first = parsed.groups[0];
      expect(first).toHaveProperty("date_label");
      expect(first).toHaveProperty("date_iso");
      expect(Array.isArray(first.messages)).toBe(true);
      const msg = first.messages[0];
      expect(msg).toHaveProperty("timestamp");
      expect(msg).toHaveProperty("from");
      expect(msg).toHaveProperty("from_type");
      expect(msg).toHaveProperty("kind");
      expect(msg).toHaveProperty("body");
      expect(msg).toHaveProperty("refs");
    });

    it("default since is 7 days ago — older messages filtered", async () => {
      writeMessages([
        {
          timestamp: isoDaysAgo(1),
          from: "ray",
          body: "recent message",
        },
        {
          timestamp: isoDaysAgo(30),
          from: "ray",
          body: "stale message",
        },
      ]);
      const result = await runCli(["view", "inbox", "--json"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.unread_count).toBe(1);
      const bodies = parsed.groups.flatMap((g: { messages: Array<{ body: string }> }) =>
        g.messages.map((m) => m.body),
      );
      expect(bodies).toContain("recent message");
      expect(bodies).not.toContain("stale message");
    });

    it("--since flag is honored", async () => {
      writeMessages([
        {
          timestamp: isoDaysAgo(1),
          from: "ray",
          body: "recent",
        },
        {
          timestamp: isoDaysAgo(10),
          from: "ray",
          body: "older",
        },
      ]);
      // Cutoff at 5 days ago — only the recent one survives.
      const since = isoDaysAgo(5);
      const result = await runCli(
        ["view", "inbox", `--since=${since}`, "--json"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.unread_count).toBe(1);
      const bodies = parsed.groups.flatMap((g: { messages: Array<{ body: string }> }) =>
        g.messages.map((m) => m.body),
      );
      expect(bodies).toContain("recent");
      expect(bodies).not.toContain("older");
    });

    it("invalid --since errors and exits 1", async () => {
      writeMessages([
        { timestamp: isoDaysAgo(1), from: "ray", body: "hi" },
      ]);
      const result = await runCli(
        ["view", "inbox", "--since=not-a-date"],
        VIEW_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
      expect(result.stderr).toContain("invalid since timestamp");
    });

    it("empty messages.jsonl renders friendly text (not an error)", async () => {
      writeFileSync(join(FLEET_DIR, "messages.jsonl"), "");
      const result = await runCli(["view", "inbox"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No messages.");
    });

    it("renders from_type glyphs distinctly for human / bot / system", async () => {
      writeMessages([
        {
          timestamp: isoDaysAgo(1),
          from: "ray",
          body: "human-msg",
        },
        {
          timestamp: isoDaysAgo(1),
          from: "generalstaff-bot",
          body: "bot-msg",
        },
        {
          timestamp: isoDaysAgo(1),
          from: "dispatcher",
          body: "system-msg",
        },
      ]);
      const result = await runCli(["view", "inbox"], VIEW_DIR);
      expect(result.exitCode).toBe(0);
      // Glyph differentiation — each message gets a distinct from_type marker.
      const humanLine = result.stdout
        .split("\n")
        .find((l) => l.includes("human-msg"));
      const botLine = result.stdout
        .split("\n")
        .find((l) => l.includes("bot-msg"));
      const systemLine = result.stdout
        .split("\n")
        .find((l) => l.includes("system-msg"));
      expect(humanLine).toBeDefined();
      expect(botLine).toBeDefined();
      expect(systemLine).toBeDefined();
      expect(humanLine).toContain("▪");
      expect(botLine).toContain("○");
      expect(systemLine).toContain("—");
    });
  });

  describe("message send subcommand (gs-240)", () => {
    const MSG_DIR = join(import.meta.dir, "fixtures", "message_send_test");
    const FLEET_DIR = join(MSG_DIR, "state", "_fleet");
    const MSG_FILE = join(FLEET_DIR, "messages.jsonl");

    const readMessages = (): Array<Record<string, unknown>> => {
      if (!existsSync(MSG_FILE)) return [];
      return readFileSync(MSG_FILE, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    };

    beforeEach(() => {
      rmSync(MSG_DIR, { recursive: true, force: true });
      mkdirSync(MSG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(MSG_DIR, { recursive: true, force: true });
    });

    it("appends an entry with --from and --body", async () => {
      const result = await runCli(
        ["message", "send", "--from=ray", "--body=hello there"],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(0);
      const msgs = readMessages();
      expect(msgs.length).toBe(1);
      expect(msgs[0].from).toBe("ray");
      expect(msgs[0].body).toBe("hello there");
      expect(typeof msgs[0].timestamp).toBe("string");
    });

    it("accepts body as a positional final argument", async () => {
      const result = await runCli(
        ["message", "send", "--from=ray", "positional body text"],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(0);
      const msgs = readMessages();
      expect(msgs.length).toBe(1);
      expect(msgs[0].body).toBe("positional body text");
    });

    it("errors and exits 1 when --from is missing", async () => {
      const result = await runCli(
        ["message", "send", "--body=orphan"],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "message send requires --from=<str> and --body=<str>",
      );
      expect(readMessages().length).toBe(0);
    });

    it("errors and exits 1 when --body is missing", async () => {
      const result = await runCli(
        ["message", "send", "--from=ray"],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "message send requires --from=<str> and --body=<str>",
      );
      expect(readMessages().length).toBe(0);
    });

    it("errors and exits 1 when --kind is invalid", async () => {
      const result = await runCli(
        [
          "message",
          "send",
          "--from=ray",
          "--body=hi",
          "--kind=bogus",
        ],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid --kind");
      expect(result.stderr).toContain("blocker");
      expect(result.stderr).toContain("handoff");
      expect(result.stderr).toContain("fyi");
      expect(result.stderr).toContain("decision");
      expect(readMessages().length).toBe(0);
    });

    it("accepts each valid --kind", async () => {
      for (const kind of ["blocker", "handoff", "fyi", "decision"]) {
        const result = await runCli(
          [
            "message",
            "send",
            "--from=ray",
            `--body=${kind}-msg`,
            `--kind=${kind}`,
          ],
          MSG_DIR,
        );
        expect(result.exitCode).toBe(0);
      }
      const msgs = readMessages();
      expect(msgs.length).toBe(4);
      const kinds = msgs.map((m) => m.kind);
      expect(kinds).toEqual(["blocker", "handoff", "fyi", "decision"]);
    });

    it("collects --session-id / --task-id / --cycle-id into refs[0]", async () => {
      const result = await runCli(
        [
          "message",
          "send",
          "--from=bot",
          "--body=shipped",
          "--session-id=sess-1",
          "--task-id=gs-240",
          "--cycle-id=cyc-9",
        ],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(0);
      const msgs = readMessages();
      expect(msgs.length).toBe(1);
      const refs = msgs[0].refs as Array<Record<string, string>>;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs.length).toBe(1);
      expect(refs[0].session_id).toBe("sess-1");
      expect(refs[0].task_id).toBe("gs-240");
      expect(refs[0].cycle_id).toBe("cyc-9");
    });

    it("omits refs when no reference flags are provided", async () => {
      const result = await runCli(
        ["message", "send", "--from=ray", "--body=naked"],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(0);
      const msgs = readMessages();
      expect(msgs.length).toBe(1);
      expect(msgs[0].refs).toBeUndefined();
      expect(msgs[0].kind).toBeUndefined();
    });

    it("--json emits the appended message object", async () => {
      const result = await runCli(
        [
          "message",
          "send",
          "--from=ray",
          "--body=jsonified",
          "--kind=fyi",
          "--task-id=gs-240",
          "--json",
        ],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.from).toBe("ray");
      expect(parsed.body).toBe("jsonified");
      expect(parsed.kind).toBe("fyi");
      expect(typeof parsed.timestamp).toBe("string");
      expect(parsed.refs).toEqual([{ task_id: "gs-240" }]);
      const msgs = readMessages();
      expect(msgs.length).toBe(1);
      expect(msgs[0].timestamp).toBe(parsed.timestamp);
    });

    it("errors on unknown message subcommand", async () => {
      const result = await runCli(
        ["message", "bogus", "--from=ray", "--body=hi"],
        MSG_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown message subcommand");
    });

    it("message --help prints usage and exits 0", async () => {
      const result = await runCli(["message", "--help"], MSG_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("message send");
      expect(result.stdout).toContain("--from");
      expect(result.stdout).toContain("--body");
    });
  });

  describe("task list --project validation (gs-238)", () => {
    const TL_DIR = join(import.meta.dir, "fixtures", "task_list_validate");

    const TL_YAML = `
projects:
  - id: generalstaff
    path: /tmp/gs
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
    hands_off:
      - CLAUDE.md
  - id: beta
    path: /tmp/beta
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
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
      rmSync(TL_DIR, { recursive: true, force: true });
      mkdirSync(join(TL_DIR, "state", "generalstaff"), { recursive: true });
      mkdirSync(join(TL_DIR, "state", "beta"), { recursive: true });
      writeFileSync(join(TL_DIR, "projects.yaml"), TL_YAML);
      writeFileSync(
        join(TL_DIR, "state", "generalstaff", "tasks.json"),
        JSON.stringify([
          { id: "gs-001", title: "gs work", status: "pending", priority: 1 },
        ]),
      );
      writeFileSync(
        join(TL_DIR, "state", "beta", "tasks.json"),
        JSON.stringify([
          { id: "bt-001", title: "beta work", status: "pending", priority: 1 },
        ]),
      );
    });

    afterEach(() => {
      rmSync(TL_DIR, { recursive: true, force: true });
    });

    it("filters output to the named project when --project=<valid-id>", async () => {
      const result = await runCli(
        ["task", "list", "--project=generalstaff"],
        TL_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("gs-001");
      expect(result.stdout).toContain("gs work");
      expect(result.stdout).not.toContain("bt-001");
      expect(result.stdout).not.toContain("beta work");
    });

    it("errors and exits 1 when --project=<unknown-id>", async () => {
      const result = await runCli(
        ["task", "list", "--project=nosuch"],
        TL_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project 'nosuch' not found");
      expect(result.stderr).toContain("Registered:");
      expect(result.stderr).toContain("generalstaff");
      expect(result.stderr).toContain("beta");
    });

    it("back-compat: default behavior unchanged for a valid --project", async () => {
      // Row format is "<id>  p<priority>  <status>  <title>" — unchanged by gs-238.
      const result = await runCli(
        ["task", "list", "--project=beta"],
        TL_DIR,
      );
      expect(result.exitCode).toBe(0);
      const line = result.stdout
        .split("\n")
        .find((l) => l.includes("bt-001"));
      expect(line).toBeDefined();
      expect(line).toContain("bt-001");
      expect(line).toContain("p1");
      expect(line).toContain("pending");
      expect(line).toContain("beta work");
    });
  });

  describe("task interactive (gs-243)", () => {
    const TI_DIR = join(import.meta.dir, "fixtures", "task_interactive");

    const TI_YAML = `
projects:
  - id: generalstaff
    path: /tmp/gs
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
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

    const TASKS_PATH = join(TI_DIR, "state", "generalstaff", "tasks.json");

    beforeEach(() => {
      rmSync(TI_DIR, { recursive: true, force: true });
      mkdirSync(join(TI_DIR, "state", "generalstaff"), { recursive: true });
      writeFileSync(join(TI_DIR, "projects.yaml"), TI_YAML);
      writeFileSync(
        TASKS_PATH,
        JSON.stringify(
          [
            {
              id: "gs-001",
              title: "first task",
              status: "pending",
              priority: 2,
              expected_touches: ["src/app.ts"],
            },
            {
              id: "gs-002",
              title: "already interactive",
              status: "pending",
              priority: 3,
              interactive_only: true,
              interactive_only_reason: "seeded flag",
            },
          ],
          null,
          2,
        ) + "\n",
      );
    });

    afterEach(() => {
      rmSync(TI_DIR, { recursive: true, force: true });
    });

    it("sets interactive_only=true on a pending task", async () => {
      const result = await runCli(
        ["task", "interactive", "--project=generalstaff", "gs-001"],
        TI_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("gs-001");
      expect(result.stdout.toLowerCase()).toContain("interactive_only");
      const saved = JSON.parse(readFileSync(TASKS_PATH, "utf8"));
      expect(saved[0].interactive_only).toBe(true);
      // Pre-existing fields on the same task must be preserved.
      expect(saved[0].id).toBe("gs-001");
      expect(saved[0].title).toBe("first task");
      expect(saved[0].status).toBe("pending");
      expect(saved[0].priority).toBe(2);
      expect(saved[0].expected_touches).toEqual(["src/app.ts"]);
      // Other tasks must be untouched.
      expect(saved[1].id).toBe("gs-002");
      expect(saved[1].interactive_only).toBe(true);
      expect(saved[1].interactive_only_reason).toBe("seeded flag");
    });

    it("--off clears interactive_only and strips the field", async () => {
      const result = await runCli(
        [
          "task",
          "interactive",
          "--project=generalstaff",
          "gs-002",
          "--off",
        ],
        TI_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("gs-002");
      const saved = JSON.parse(readFileSync(TASKS_PATH, "utf8"));
      expect("interactive_only" in saved[1]).toBe(false);
      // Unrelated fields preserved.
      expect(saved[1].id).toBe("gs-002");
      expect(saved[1].title).toBe("already interactive");
      expect(saved[1].status).toBe("pending");
      expect(saved[1].priority).toBe(3);
    });

    it("errors and exits 1 when task-id is unknown", async () => {
      const result = await runCli(
        ["task", "interactive", "--project=generalstaff", "gs-999"],
        TI_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("gs-999");
      expect(result.stderr).toContain("not found");
      // File must not be rewritten on error paths.
      const raw = readFileSync(TASKS_PATH, "utf8");
      const saved = JSON.parse(raw);
      expect(saved[0].interactive_only).toBeUndefined();
      expect(saved[1].interactive_only).toBe(true);
    });

    it("errors and exits 1 when --project is missing", async () => {
      const result = await runCli(
        ["task", "interactive", "gs-001"],
        TI_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--project");
    });

    it("preserves JSON formatting (2-space indent, trailing newline)", async () => {
      const result = await runCli(
        ["task", "interactive", "--project=generalstaff", "gs-001"],
        TI_DIR,
      );
      expect(result.exitCode).toBe(0);
      const raw = readFileSync(TASKS_PATH, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      // 2-space indent — every indented line starts with an even
      // count of leading spaces; check one concrete sample line.
      expect(raw).toContain('  {\n');
      expect(raw).toContain('    "id": "gs-001"');
      // Task order preserved.
      const saved = JSON.parse(raw);
      expect(saved.map((t: { id: string }) => t.id)).toEqual([
        "gs-001",
        "gs-002",
      ]);
    });

    it("is a no-op with a friendly message when flag already matches target", async () => {
      // gs-002 is already interactive_only=true; setting it again should
      // print an 'already' notice and not rewrite the file content.
      const before = readFileSync(TASKS_PATH, "utf8");
      const result = await runCli(
        ["task", "interactive", "--project=generalstaff", "gs-002"],
        TI_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain("already");
      const after = readFileSync(TASKS_PATH, "utf8");
      expect(after).toBe(before);
    });
  });

  describe("task validate (gs-248)", () => {
    const TV_DIR = join(import.meta.dir, "fixtures", "task_validate");

    const TV_YAML = `
projects:
  - id: generalstaff
    path: /tmp/gs
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
    hands_off:
      - CLAUDE.md
  - id: beta
    path: /tmp/beta
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
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
      rmSync(TV_DIR, { recursive: true, force: true });
      mkdirSync(join(TV_DIR, "state", "generalstaff"), { recursive: true });
      mkdirSync(join(TV_DIR, "state", "beta"), { recursive: true });
      writeFileSync(join(TV_DIR, "projects.yaml"), TV_YAML);
    });

    afterEach(() => {
      rmSync(TV_DIR, { recursive: true, force: true });
    });

    function writeTasks(projectId: string, body: unknown) {
      writeFileSync(
        join(TV_DIR, "state", projectId, "tasks.json"),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }

    it("(a) all-green passes exit 0 across every registered project", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "ok", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-001", title: "ok", status: "done", priority: 2 },
      ]);
      const result = await runCli(["task", "validate"], TV_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff: ok");
      expect(result.stdout).toContain("beta: ok");
    });

    it("(b) malformed tasks.json in one project → exit 1 and names that project", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "ok", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [{ id: "bt-001", title: "no priority", status: "pending" }]);
      const result = await runCli(["task", "validate"], TV_DIR);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("generalstaff: ok");
      expect(result.stdout).toContain("beta: FAIL");
      expect(result.stdout.toLowerCase()).toContain("priority");
    });

    it("(c) --project=<id> filters to that project only", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "ok", status: "pending", priority: 1 },
      ]);
      // beta has malformed tasks but should not be checked under --project filter
      writeTasks("beta", "{not valid json");
      const result = await runCli(
        ["task", "validate", "--project=generalstaff"],
        TV_DIR,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff: ok");
      expect(result.stdout).not.toContain("beta");
    });

    it("(d) unknown --project errors and exits 1", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "ok", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-001", title: "ok", status: "pending", priority: 1 },
      ]);
      const result = await runCli(
        ["task", "validate", "--project=nosuch"],
        TV_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project 'nosuch' not found");
      expect(result.stderr).toContain("Registered:");
    });

    it("(e) --json emits { project_id: {ok, errors: [...]} } map", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "ok", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-001", title: "bad status", status: "weird", priority: 1 },
      ]);
      const result = await runCli(["task", "validate", "--json"], TV_DIR);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout) as Record<
        string,
        { ok: boolean; errors: string[] }
      >;
      expect(parsed.generalstaff).toBeDefined();
      expect(parsed.generalstaff!.ok).toBe(true);
      expect(parsed.generalstaff!.errors).toEqual([]);
      expect(parsed.beta).toBeDefined();
      expect(parsed.beta!.ok).toBe(false);
      expect(parsed.beta!.errors.length).toBeGreaterThan(0);
      expect(parsed.beta!.errors[0]!.toLowerCase()).toContain("status");
    });
  });

  describe("task next (gs-250)", () => {
    const TN_DIR = join(import.meta.dir, "fixtures", "task_next");

    // project.path needs to match getRootDir() (TN_DIR) so that the
    // pickNextProjects empty-queue filter — which reads
    // <project.path>/state/<id>/tasks.json — sees the same tasks.json
    // the CLI writes under getRootDir(). Concurrency detection defaults
    // to "none" so the absent `.bot-worktree` under TN_DIR is fine.
    const tnYaml = (): string => `
projects:
  - id: generalstaff
    path: ${TN_DIR.replace(/\\/g, "/")}
    priority: 1
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
    hands_off:
      - CLAUDE.md
      - src/safety.ts
  - id: beta
    path: ${TN_DIR.replace(/\\/g, "/")}
    priority: 2
    engineer_command: "echo hi"
    verification_command: "echo ok"
    cycle_budget_minutes: 30
    branch: bot/work
    hands_off:
      - README.md
dispatcher:
  state_dir: ./state
  fleet_state_file: ./fleet_state.json
  stop_file: ./STOP
  override_file: ./next_project.txt
  picker: priority_x_staleness
  max_cycles_per_project_per_session: 3
  max_parallel_slots: 2
  log_dir: ./logs
  digest_dir: ./digests
`;

    beforeEach(() => {
      rmSync(TN_DIR, { recursive: true, force: true });
      mkdirSync(join(TN_DIR, "state", "generalstaff"), { recursive: true });
      mkdirSync(join(TN_DIR, "state", "beta"), { recursive: true });
      writeFileSync(join(TN_DIR, "projects.yaml"), tnYaml());
    });

    afterEach(() => {
      rmSync(TN_DIR, { recursive: true, force: true });
    });

    function writeTasks(projectId: string, body: unknown) {
      writeFileSync(
        join(TN_DIR, "state", projectId, "tasks.json"),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }

    it("(a) picks the lowest-priority, lowest-id pending task per slot", async () => {
      writeTasks("generalstaff", [
        { id: "gs-003", title: "priority 2 higher id", status: "pending", priority: 2 },
        { id: "gs-001", title: "priority 2 lower id", status: "pending", priority: 2 },
        { id: "gs-002", title: "priority 1 wins", status: "pending", priority: 1 },
        { id: "gs-004", title: "already done", status: "done", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-010", title: "beta top task", status: "pending", priority: 1 },
      ]);
      const result = await runCli(["task", "next", "--json"], TN_DIR);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        slots: Array<{ project_id: string; task_id: string | null; title: string | null }>;
      };
      expect(payload.slots.length).toBe(2);
      const slotByProject = new Map(payload.slots.map((s) => [s.project_id, s]));
      expect(slotByProject.get("generalstaff")?.task_id).toBe("gs-002");
      expect(slotByProject.get("beta")?.task_id).toBe("bt-010");
    });

    it("(b) skips interactive_only and hands_off-intersecting tasks", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "interactive only", status: "pending", priority: 1, interactive_only: true },
        { id: "gs-002", title: "touches hands_off", status: "pending", priority: 1, expected_touches: ["src/safety.ts"] },
        { id: "gs-003", title: "pickable", status: "pending", priority: 2 },
      ]);
      writeTasks("beta", []);
      const result = await runCli(["task", "next", "--json"], TN_DIR);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        slots: Array<{ project_id: string; task_id: string | null }>;
      };
      const gs = payload.slots.find((s) => s.project_id === "generalstaff");
      expect(gs?.task_id).toBe("gs-003");
      const beta = payload.slots.find((s) => s.project_id === "beta");
      // beta has no pickable tasks → not present in parallel-mode picks
      // (gs-232 filters empty-queue projects at max_parallel_slots > 1).
      expect(beta).toBeUndefined();
    });

    it("(c) --project=<id> restricts preview to one project", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "gs top", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-001", title: "beta top", status: "pending", priority: 1 },
      ]);
      const result = await runCli(
        ["task", "next", "--project=beta", "--json"],
        TN_DIR,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        slots: Array<{ project_id: string; task_id: string | null }>;
      };
      expect(payload.slots.length).toBe(1);
      expect(payload.slots[0]!.project_id).toBe("beta");
      expect(payload.slots[0]!.task_id).toBe("bt-001");
    });

    it("(d) empty queues across every project emit an empty slots array", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "done", status: "done", priority: 1 },
      ]);
      writeTasks("beta", []);
      const result = await runCli(["task", "next", "--json"], TN_DIR);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        slots: Array<{ project_id: string }>;
      };
      expect(payload.slots).toEqual([]);
    });

    it("(e) unknown --project errors and exits 1", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "ok", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-001", title: "ok", status: "pending", priority: 1 },
      ]);
      const result = await runCli(
        ["task", "next", "--project=nosuch", "--json"],
        TN_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project 'nosuch' not found");
      expect(result.stderr).toContain("Registered:");
    });

    it("(f) non-JSON output lists one row per slot with project_id task_id title", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "the top task", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", [
        { id: "bt-001", title: "beta top", status: "pending", priority: 1 },
      ]);
      const result = await runCli(["task", "next"], TN_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("generalstaff");
      expect(result.stdout).toContain("gs-001");
      expect(result.stdout).toContain("the top task");
      expect(result.stdout).toContain("beta");
      expect(result.stdout).toContain("bt-001");
    });

    it("(g) does not mutate tasks.json or create any state files", async () => {
      writeTasks("generalstaff", [
        { id: "gs-001", title: "the top task", status: "pending", priority: 1 },
      ]);
      writeTasks("beta", []);
      const tasksPath = join(TN_DIR, "state", "generalstaff", "tasks.json");
      const before = readFileSync(tasksPath, "utf8");
      const fleetPath = join(TN_DIR, "fleet_state.json");
      const result = await runCli(["task", "next", "--json"], TN_DIR);
      expect(result.exitCode).toBe(0);
      const after = readFileSync(tasksPath, "utf8");
      expect(after).toBe(before);
      // fleet_state.json shouldn't be created as a side-effect of preview.
      expect(existsSync(fleetPath)).toBe(false);
    });
  });
});

// gs-242: new sanity-check helpers surfaced by `doctor` with ✓/✗
// markers. Unit-tested directly; the CLI-integration assertions lean
// on the existing `runCli(["doctor"])` flow covered by doctor.test.ts.
describe("doctor sanity checks (gs-242)", () => {
  const FIXTURE = join(tmpdir(), "gs-242-doctor-sanity");

  beforeEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  function makeProject(id: string, path: string) {
    return {
      id,
      path,
      priority: 1,
      engineer_command: "echo hi",
      verification_command: "echo ok",
      cycle_budget_minutes: 30,
      hands_off: ["CLAUDE.md"],
    } as unknown as import("../src/types").ProjectConfig;
  }

  it("checkProjectPaths passes for every valid git repo (all-green fixture)", async () => {
    const { checkProjectPaths } = await import("../src/doctor");
    const repoA = join(FIXTURE, "repo-a");
    const repoB = join(FIXTURE, "repo-b");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });
    const result = checkProjectPaths([
      makeProject("a", repoA),
      makeProject("b", repoB),
    ]);
    expect(result.problems).toEqual([]);
    expect(result.okDetail).toContain("2 project(s)");
  });

  it("checkProjectPaths flags a missing project.path and includes it in the detail", async () => {
    const { checkProjectPaths } = await import("../src/doctor");
    const missing = join(FIXTURE, "does-not-exist");
    const result = checkProjectPaths([makeProject("ghost", missing)]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!).toContain("ghost");
    expect(result.problems[0]!).toContain(missing);
  });

  it("checkProjectStateDirs passes when state dir exists and PROGRESS.jsonl is readable", async () => {
    const { checkProjectStateDirs } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    try {
      mkdirSync(join(FIXTURE, "state", "alpha"), { recursive: true });
      writeFileSync(
        join(FIXTURE, "state", "alpha", "PROGRESS.jsonl"),
        '{"event":"test"}\n',
      );
      const result = checkProjectStateDirs([
        makeProject("alpha", join(FIXTURE, "repo")),
      ]);
      expect(result.problems).toEqual([]);
    } finally {
      setRootDir(originalRoot);
    }
  });

  it("checkProjectStateDirs flags a project whose state dir is missing", async () => {
    const { checkProjectStateDirs } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    try {
      const result = checkProjectStateDirs([
        makeProject("beta", join(FIXTURE, "repo")),
      ]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!).toContain("beta");
      expect(result.problems[0]!).toContain("missing state dir");
    } finally {
      setRootDir(originalRoot);
    }
  });

  it("checkProjectTasksJson flags malformed JSON with project id in detail", async () => {
    const { checkProjectTasksJson } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    try {
      mkdirSync(join(FIXTURE, "state", "broken"), { recursive: true });
      writeFileSync(
        join(FIXTURE, "state", "broken", "tasks.json"),
        "{not valid json",
      );
      const result = checkProjectTasksJson([
        makeProject("broken", join(FIXTURE, "repo")),
      ]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!).toContain("broken");
      expect(result.problems[0]!).toContain("tasks.json");
    } finally {
      setRootDir(originalRoot);
    }
  });

  it("checkProjectTasksJson passes when tasks.json is absent (not every project uses it)", async () => {
    const { checkProjectTasksJson } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    try {
      const result = checkProjectTasksJson([
        makeProject("none", join(FIXTURE, "repo")),
      ]);
      expect(result.problems).toEqual([]);
      expect(result.okDetail).toContain("no tasks.json");
    } finally {
      setRootDir(originalRoot);
    }
  });

  it("checkDigestsWritable passes when digests/ exists and is writable", async () => {
    const { checkDigestsWritable } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    try {
      mkdirSync(join(FIXTURE, "digests"), { recursive: true });
      const result = checkDigestsWritable();
      expect(result.problems).toEqual([]);
      expect(result.okDetail).toContain("digests/");
    } finally {
      setRootDir(originalRoot);
    }
  });

  it("checkDigestsWritable still passes when digests/ is missing but parent is writable", async () => {
    const { checkDigestsWritable } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    try {
      // No digests/ created. Parent FIXTURE is writable by test owner.
      const result = checkDigestsWritable();
      expect(result.problems).toEqual([]);
      expect(result.okDetail).toContain("will be created");
    } finally {
      setRootDir(originalRoot);
    }
  });

  it("runDoctor prints ✓ markers for the new sanity checks on an all-green fixture", async () => {
    const { runDoctor } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    const originalLog = console.log;
    const out: string[] = [];
    console.log = (...args: unknown[]) => {
      out.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const repo = join(FIXTURE, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(FIXTURE, "state", "solo"), { recursive: true });
      mkdirSync(join(FIXTURE, "digests"), { recursive: true });
      await runDoctor({
        loadProjects: async () => [makeProject("solo", repo)],
        exitOnFailure: false,
      });
      const joined = out.join("\n");
      expect(joined).toContain("Sanity checks");
      expect(joined).toMatch(/✓\s+project paths/);
      expect(joined).toMatch(/✓\s+state dirs/);
      expect(joined).toMatch(/✓\s+tasks\.json/);
      expect(joined).toMatch(/✓\s+digests\//);
    } finally {
      console.log = originalLog;
      setRootDir(originalRoot);
    }
  });

  it("runDoctor prints ✗ markers when a project path is missing or tasks.json is malformed", async () => {
    const { runDoctor } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    const originalLog = console.log;
    const out: string[] = [];
    console.log = (...args: unknown[]) => {
      out.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // Project path missing entirely.
      const ghost = makeProject("ghost", join(FIXTURE, "nope"));
      // Project whose tasks.json is malformed.
      const junk = makeProject("junk", join(FIXTURE, "junk-repo"));
      mkdirSync(join(FIXTURE, "junk-repo", ".git"), { recursive: true });
      mkdirSync(join(FIXTURE, "state", "junk"), { recursive: true });
      writeFileSync(
        join(FIXTURE, "state", "junk", "tasks.json"),
        "not-json",
      );
      await runDoctor({
        loadProjects: async () => [ghost, junk],
        exitOnFailure: false,
      });
      const joined = out.join("\n");
      expect(joined).toMatch(/✗\s+project paths.*ghost/);
      expect(joined).toMatch(/✗\s+tasks\.json.*junk/);
    } finally {
      console.log = originalLog;
      setRootDir(originalRoot);
    }
  });
});

// gs-246: --verbose adds per-check context lines under each passing
// sanity check. Default output is unchanged; failing checks are not
// decorated.
describe("doctor --verbose (gs-246)", () => {
  const FIXTURE = join(tmpdir(), "gs-246-doctor-verbose");

  beforeEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  function makeProject(id: string, path: string) {
    return {
      id,
      path,
      priority: 1,
      engineer_command: "echo hi",
      verification_command: "echo ok",
      cycle_budget_minutes: 30,
      hands_off: ["CLAUDE.md"],
    } as unknown as import("../src/types").ProjectConfig;
  }

  async function runDoctorCapture(
    verbose: boolean,
    setup: (fixture: string) => Promise<void> | void,
    projects: () => import("../src/types").ProjectConfig[],
  ): Promise<string> {
    const { runDoctor } = await import("../src/doctor");
    const { setRootDir, getRootDir } = await import("../src/state");
    const originalRoot = getRootDir();
    setRootDir(FIXTURE);
    const originalLog = console.log;
    const out: string[] = [];
    console.log = (...args: unknown[]) => {
      out.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await setup(FIXTURE);
      await runDoctor({
        loadProjects: async () => projects(),
        exitOnFailure: false,
        verbose,
      });
    } finally {
      console.log = originalLog;
      setRootDir(originalRoot);
    }
    return out.join("\n");
  }

  function sanityBlock(joined: string): string {
    const idx = joined.indexOf("Sanity checks");
    return idx < 0 ? "" : joined.slice(idx);
  }

  it("default (no --verbose) output contains no per-check context lines", async () => {
    const repo = join(FIXTURE, "repo");
    const joined = await runDoctorCapture(
      false,
      () => {
        mkdirSync(join(repo, ".git"), { recursive: true });
        mkdirSync(join(FIXTURE, "state", "solo"), { recursive: true });
        mkdirSync(join(FIXTURE, "digests"), { recursive: true });
      },
      () => [makeProject("solo", repo)],
    );
    const block = sanityBlock(joined);
    expect(block).toMatch(/✓\s+project paths/);
    // No indented "solo: <path> @ <sha>" detail line in default mode.
    expect(block).not.toMatch(/^\s{6}solo:/m);
    // No digests absolute-path detail line in default mode (the
    // okDetail already mentions the path, so we specifically check
    // there's no standalone indented line).
    expect(block).not.toMatch(/^\s{6}[A-Za-z]:[\\/]/m);
  });

  it("--verbose adds context lines under each passing sanity check", async () => {
    const repo = join(FIXTURE, "repo");
    const joined = await runDoctorCapture(
      true,
      async () => {
        mkdirSync(repo, { recursive: true });
        // Real git repo so rev-parse --short HEAD produces a SHA.
        await $`git -C ${repo} init -q`.nothrow();
        await $`git -C ${repo} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`
          .nothrow();
        const stateDir = join(FIXTURE, "state", "solo");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "PROGRESS.jsonl"), '{"event":"t"}\n');
        writeFileSync(
          join(stateDir, "tasks.json"),
          JSON.stringify([{ id: "a-1" }, { id: "a-2" }, { id: "a-3" }]),
        );
        mkdirSync(join(FIXTURE, "digests"), { recursive: true });
      },
      () => [makeProject("solo", repo)],
    );
    const block = sanityBlock(joined);
    // project paths: resolved path + SHA (7-char short hash or unknown)
    expect(block).toMatch(/solo: .*repo @ (?:[0-9a-f]{7,}|unknown)/);
    // state dirs: PROGRESS.jsonl byte size
    expect(block).toMatch(/solo: PROGRESS\.jsonl \d+ bytes/);
    // tasks.json: task count
    expect(block).toMatch(/solo: 3 task\(s\)/);
    // digests/: absolute path line
    expect(block).toContain(join(FIXTURE, "digests"));
  });

  it("--verbose leaves failing check output unchanged (no extra context)", async () => {
    // ghost project has a missing path — the project paths check
    // fails, and so does state dirs (no state/ghost) and tasks.json
    // absent isn't a failure. We assert that the ghost id does NOT
    // appear under an indented ✓ verbose line for project paths.
    const joined = await runDoctorCapture(
      true,
      () => { /* no setup — ghost path will be absent */ },
      () => [makeProject("ghost", join(FIXTURE, "does-not-exist"))],
    );
    const block = sanityBlock(joined);
    expect(block).toMatch(/✗\s+project paths.*ghost/);
    // The verbose detail line format starts with 6 spaces + id + ":".
    // We want no such line for the failing project path check.
    expect(block).not.toMatch(/^\s{6}ghost: .* @ /m);
  });

  it("CLI integration: generalstaff doctor --verbose runs end-to-end", async () => {
    // End-to-end smoke: the flag is parsed without error. The exit
    // code may be non-zero if the host repo's doctor flags anything
    // (e.g. missing claude binary) — we only assert no parser error.
    const result = await runCli(["doctor", "--verbose"]);
    expect(result.stderr).not.toContain("Unknown option");
    expect(result.stdout).toContain("GeneralStaff Doctor");
  });

  // gs-247: --since=<iso> narrows --sessions / --summary to
  // PROGRESS.jsonl events at or after a caller-supplied ISO timestamp.
  describe("status --since (gs-247)", () => {
    const SINCE_DIR = join(import.meta.dir, "fixtures", "status_since_test");
    const FLEET_LOG = join(SINCE_DIR, "state", "_fleet", "PROGRESS.jsonl");
    const ALPHA_LOG = join(SINCE_DIR, "state", "alpha", "PROGRESS.jsonl");

    const PROJECTS_YAML = `
projects:
  - id: alpha
    path: ${SINCE_DIR.replace(/\\/g, "/")}
    priority: 1
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

    const sessionEvents = [
      {
        timestamp: "2026-04-17T10:30:00.000Z",
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
        timestamp: "2026-04-17T13:00:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 60,
          total_cycles: 5,
          total_verified: 4,
          total_failed: 1,
          stop_reason: "max-cycles",
          reviewer: "openrouter",
        },
      },
      {
        timestamp: "2026-04-17T18:15:00.000Z",
        event: "session_complete",
        project_id: "_fleet",
        data: {
          duration_minutes: 15,
          total_cycles: 1,
          total_verified: 1,
          total_failed: 0,
          stop_reason: "budget",
          reviewer: "claude",
        },
      },
    ];

    beforeEach(() => {
      mkdirSync(join(SINCE_DIR, "state", "_fleet"), { recursive: true });
      mkdirSync(join(SINCE_DIR, "state", "alpha"), { recursive: true });
      writeFileSync(join(SINCE_DIR, "projects.yaml"), PROJECTS_YAML);
      writeFileSync(
        FLEET_LOG,
        sessionEvents.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      const cycleEvents = [
        {
          timestamp: "2026-04-17T10:15:00.000Z",
          event: "cycle_end",
          project_id: "alpha",
          data: { outcome: "verified", duration_seconds: 120 },
        },
        {
          timestamp: "2026-04-17T12:30:00.000Z",
          event: "cycle_end",
          project_id: "alpha",
          data: { outcome: "verified", duration_seconds: 240 },
        },
        {
          timestamp: "2026-04-17T18:00:00.000Z",
          event: "cycle_end",
          project_id: "alpha",
          data: { outcome: "verification_failed", duration_seconds: 60 },
        },
      ];
      writeFileSync(
        ALPHA_LOG,
        cycleEvents.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
    });

    afterEach(() => {
      rmSync(SINCE_DIR, { recursive: true, force: true });
    });

    it("--sessions --since=<valid> filters the sessions list", async () => {
      const result = await runCli(
        ["status", "--sessions", "--since=2026-04-17T12:00:00.000Z", "--json"],
        SINCE_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveLength(2);
      // Newest first — 18:00 session, then 12:00 session. The 10:00 one is excluded.
      expect(parsed[0].started_at).toBe("2026-04-17T18:00:00.000Z");
      expect(parsed[1].started_at).toBe("2026-04-17T12:00:00.000Z");
    });

    it("--summary --since=<valid> filters today's-style summary to the window", async () => {
      const result = await runCli(
        ["status", "--summary", "--since=2026-04-17T12:00:00.000Z", "--json"],
        SINCE_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Only cycle_end events at/after 12:00 count: the 12:30 verified
      // and the 18:00 failed. The 10:15 event is outside the window.
      expect(parsed.cycles_total).toBe(2);
      expect(parsed.verified).toBe(1);
      expect(parsed.verification_failed).toBe(1);
      // session_complete windowing: only the 13:00 (60min) + 18:15
      // (15min) sessions land inside the window. 10:30 session falls
      // outside.
      expect(parsed.wall_clock_minutes).toBe(75);
      expect(parsed.last_session_end).toBe("2026-04-17T18:15:00.000Z");
    });

    it("rejects an unparseable --since value with a clear error", async () => {
      const result = await runCli(
        ["status", "--sessions", "--since=not-a-date"],
        SINCE_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: --since requires an ISO timestamp",
      );
    });

    it("rejects relative durations (those belong to audit's --since, not status's)", async () => {
      const result = await runCli(
        ["status", "--summary", "--since=30m"],
        SINCE_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: --since requires an ISO timestamp",
      );
    });

    it("rejects --since without --sessions or --summary", async () => {
      const result = await runCli(
        ["status", "--since=2026-04-17T12:00:00.000Z"],
        SINCE_DIR,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Error: --since requires --sessions or --summary",
      );
    });

    it("inclusive boundary: --sessions --since=<ts> includes a session that started exactly at <ts>", async () => {
      // The 13:00 session was computed from a 14:00 timestamp minus 60min duration
      // so --since=2026-04-17T12:00:00.000Z should include it on the boundary.
      const result = await runCli(
        ["status", "--sessions", "--since=2026-04-17T12:00:00.000Z", "--json"],
        SINCE_DIR,
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const startedAts = parsed.map((s: { started_at: string }) => s.started_at);
      expect(startedAts).toContain("2026-04-17T12:00:00.000Z");
    });
  });
});
