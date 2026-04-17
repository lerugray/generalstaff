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

  describe("help completeness", () => {
    it("lists all registered commands in help output", async () => {
      const result = await runCli(["--help"]);
      const help = result.stdout;
      const expectedCommands = [
        "session", "cycle", "status", "stop", "start",
        "log", "projects", "init", "history", "doctor", "clean",
      ];
      for (const cmd of expectedCommands) {
        expect(help).toContain(`generalstaff ${cmd}`);
      }
    });
  });
});
