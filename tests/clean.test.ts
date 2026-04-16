import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from "fs";
import { join } from "path";
import { runClean } from "../src/clean";
import { setRootDir } from "../src/state";

const TEST_DIR = join(import.meta.dir, "fixtures", "clean_test");

const MINIMAL_PROJECTS_YAML = `
projects:
  - id: alpha
    path: /tmp/clean-alpha-nonexistent
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

function setMtimeDaysAgo(filePath: string, daysAgo: number) {
  const t = (Date.now() - daysAgo * 86_400_000) / 1000;
  utimesSync(filePath, t, t);
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "projects.yaml"), MINIMAL_PROJECTS_YAML);
  setRootDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("runClean log rotation", () => {
  it("deletes log files older than the default 30-day threshold", async () => {
    const logsDir = join(TEST_DIR, "logs");
    mkdirSync(logsDir, { recursive: true });

    const oldFile = join(logsDir, "old.log");
    const newFile = join(logsDir, "new.log");
    writeFileSync(oldFile, "stale\n");
    writeFileSync(newFile, "fresh\n");
    setMtimeDaysAgo(oldFile, 45);
    setMtimeDaysAgo(newFile, 5);

    await runClean(20, 30);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("respects a custom --log-days threshold", async () => {
    const logsDir = join(TEST_DIR, "logs");
    mkdirSync(logsDir, { recursive: true });

    const day3 = join(logsDir, "day3.log");
    const day10 = join(logsDir, "day10.log");
    writeFileSync(day3, "x");
    writeFileSync(day10, "y");
    setMtimeDaysAgo(day3, 3);
    setMtimeDaysAgo(day10, 10);

    // Threshold = 7 days: day10 is older than 7 days, day3 is not.
    await runClean(20, 7);

    expect(existsSync(day3)).toBe(true);
    expect(existsSync(day10)).toBe(false);
  });

  it("reports the count of deleted log files in the output", async () => {
    const logsDir = join(TEST_DIR, "logs");
    mkdirSync(logsDir, { recursive: true });

    for (let i = 0; i < 3; i++) {
      const f = join(logsDir, `old-${i}.log`);
      writeFileSync(f, "x");
      setMtimeDaysAgo(f, 60);
    }
    const fresh = join(logsDir, "fresh.log");
    writeFileSync(fresh, "x");
    setMtimeDaysAgo(fresh, 1);

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await runClean(20, 30);
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");
    expect(output).toMatch(/Deleted 3 log file\(s\) older than 30 day\(s\)/);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(logsDir)).toEqual(["fresh.log"]);
  });

  it("does nothing when logs/ directory does not exist", async () => {
    expect(existsSync(join(TEST_DIR, "logs"))).toBe(false);
    await expect(runClean(20, 30)).resolves.toBeUndefined();
  });
});
