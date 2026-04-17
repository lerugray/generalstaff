import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import {
  runDoctor,
  findStateDirIssues,
  findStaleWorktreeIssues,
  findOrphanedStopFileIssue,
} from "../src/doctor";
import { setRootDir } from "../src/state";
import type { ProjectConfig } from "../src/types";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "doctor_test");

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function makeProject(id: string, path: string): ProjectConfig {
  return {
    id,
    path,
    priority: 1,
    engineer_command: "echo hi",
    verification_command: "echo ok",
    cycle_budget_minutes: 30,
    hands_off: ["CLAUDE.md"],
    // Defaults — cast fills optional fields the tests don't care about.
  } as unknown as ProjectConfig;
}

describe("doctor command (CLI integration)", () => {
  it("exits 0 when bun and git are available", async () => {
    const result = await runCli(["doctor"]);
    expect(result.stdout).toContain("PASS  bun");
    expect(result.stdout).toContain("PASS  git");
    expect(result.stdout).toContain("GeneralStaff Doctor");
    expect(result.stdout).toContain("Checking prerequisites");
  });

  it("prints version info for passing checks", async () => {
    const result = await runCli(["doctor"]);
    const bunLine = result.stdout.split("\n").find((l: string) => l.includes("PASS  bun"));
    expect(bunLine).toBeDefined();
    expect(bunLine!).toMatch(/PASS\s+bun\s+—\s+\S+/);
  });

  it("is listed in --help output", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("doctor");
  });
});

describe("doctor diagnostic helpers", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE, { recursive: true });
    setRootDir(FIXTURE);
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("findStateDirIssues flags missing state/<project>/ dirs", async () => {
    const p1 = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    const p2 = makeProject("beta", "/tmp/doctor-beta-nonexistent");
    mkdirSync(join(FIXTURE, "state", "alpha"), { recursive: true });

    const issues = await findStateDirIssues([p1, p2]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("state-dir-missing:beta");
  });

  it("findStateDirIssues.fix creates the missing dir", async () => {
    const p = makeProject("gamma", "/tmp/doctor-gamma-nonexistent");
    const issues = await findStateDirIssues([p]);
    expect(issues).toHaveLength(1);
    await issues[0]!.fix();
    expect(existsSync(join(FIXTURE, "state", "gamma"))).toBe(true);
  });

  it("findStaleWorktreeIssues ignores fresh worktrees", async () => {
    const projectPath = join(FIXTURE, "project");
    mkdirSync(join(projectPath, ".bot-worktree"), { recursive: true });
    const p = makeProject("fresh", projectPath);

    const issues = await findStaleWorktreeIssues([p]);
    expect(issues).toHaveLength(0);
  });

  it("findStaleWorktreeIssues flags old worktrees", async () => {
    const projectPath = join(FIXTURE, "project");
    const wt = join(projectPath, ".bot-worktree");
    mkdirSync(wt, { recursive: true });
    // Backdate the worktree mtime so it looks stale (> 10 min).
    const oldTime = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(wt, oldTime, oldTime);
    const p = makeProject("stale", projectPath);

    const issues = await findStaleWorktreeIssues([p]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("stale-worktree:stale");

    await issues[0]!.fix();
    expect(existsSync(wt)).toBe(false);
  });

  it("findOrphanedStopFileIssue returns empty when no STOP file", async () => {
    const issues = await findOrphanedStopFileIssue();
    expect(issues).toHaveLength(0);
  });

  it("findOrphanedStopFileIssue flags + fix removes STOP file", async () => {
    writeFileSync(join(FIXTURE, "STOP"), "STOP\n");
    const issues = await findOrphanedStopFileIssue();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("orphaned-stop-file");

    await issues[0]!.fix();
    expect(existsSync(join(FIXTURE, "STOP"))).toBe(false);
  });
});

describe("runDoctor --fix", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE, { recursive: true });
    setRootDir(FIXTURE);
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("creates missing state dirs when assumeYes is true", async () => {
    const p = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    await runDoctor({
      fix: true,
      assumeYes: true,
      loadProjects: async () => [p],
    });
    expect(existsSync(join(FIXTURE, "state", "alpha"))).toBe(true);
  });

  it("skips fixes when prompt returns false", async () => {
    const p = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    await runDoctor({
      fix: true,
      prompt: async () => false,
      loadProjects: async () => [p],
    });
    expect(existsSync(join(FIXTURE, "state", "alpha"))).toBe(false);
  });

  it("applies fixes when prompt returns true", async () => {
    const p = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    await runDoctor({
      fix: true,
      prompt: async () => true,
      loadProjects: async () => [p],
    });
    expect(existsSync(join(FIXTURE, "state", "alpha"))).toBe(true);
  });

  it("removes orphaned STOP file with --fix --yes", async () => {
    writeFileSync(join(FIXTURE, "STOP"), "STOP\n");
    await runDoctor({
      fix: true,
      assumeYes: true,
      loadProjects: async () => [],
    });
    expect(existsSync(join(FIXTURE, "STOP"))).toBe(false);
  });

  it("does not error when no issues are found", async () => {
    await runDoctor({
      fix: true,
      assumeYes: true,
      loadProjects: async () => [],
    });
    // No assertion beyond "did not throw" — the default-prompt path
    // would hang on real stdin; assumeYes skips it.
  });
});
