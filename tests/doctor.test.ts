import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import {
  runDoctor,
  findStateDirIssues,
  findStaleWorktreeIssues,
  findOrphanedStopFileIssue,
  findProjectPathProblems,
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
      exitOnFailure: false,
    });
    expect(existsSync(join(FIXTURE, "state", "alpha"))).toBe(true);
  });

  it("skips fixes when prompt returns false", async () => {
    const p = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    await runDoctor({
      fix: true,
      prompt: async () => false,
      loadProjects: async () => [p],
      exitOnFailure: false,
    });
    expect(existsSync(join(FIXTURE, "state", "alpha"))).toBe(false);
  });

  it("applies fixes when prompt returns true", async () => {
    const p = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    await runDoctor({
      fix: true,
      prompt: async () => true,
      loadProjects: async () => [p],
      exitOnFailure: false,
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

describe("findProjectPathProblems", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE, { recursive: true });
    setRootDir(FIXTURE);
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("returns no problems when path exists and .git is present", async () => {
    const projectPath = join(FIXTURE, "real-repo");
    mkdirSync(join(projectPath, ".git"), { recursive: true });
    const p = makeProject("real", projectPath);
    expect(await findProjectPathProblems([p])).toEqual([]);
  });

  it("flags missing project path with remediation hint", async () => {
    const p = makeProject("ghost", join(FIXTURE, "does-not-exist"));
    const problems = await findProjectPathProblems([p]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!).toContain("ghost: path does not exist");
    expect(problems[0]!).toContain("projects.yaml");
  });

  it("flags path that exists but is not a git repo", async () => {
    const projectPath = join(FIXTURE, "not-git");
    mkdirSync(projectPath, { recursive: true });
    const p = makeProject("bare", projectPath);
    const problems = await findProjectPathProblems([p]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!).toContain("bare: not a git repository");
    expect(problems[0]!).toContain("git init");
  });

  it("accepts worktree-style .git file (not just directory)", async () => {
    const projectPath = join(FIXTURE, "worktree-repo");
    mkdirSync(projectPath, { recursive: true });
    // Worktrees use a plain file .git pointing at the real gitdir.
    writeFileSync(join(projectPath, ".git"), "gitdir: /fake/.git/worktrees/x\n");
    const p = makeProject("wt", projectPath);
    expect(await findProjectPathProblems([p])).toEqual([]);
  });

  it("collects problems for every affected project", async () => {
    const ok = join(FIXTURE, "ok");
    mkdirSync(join(ok, ".git"), { recursive: true });
    const noPath = join(FIXTURE, "missing");
    const noGit = join(FIXTURE, "notgit");
    mkdirSync(noGit, { recursive: true });
    const projects = [
      makeProject("ok", ok),
      makeProject("missing", noPath),
      makeProject("notgit", noGit),
    ];
    const problems = await findProjectPathProblems(projects);
    expect(problems).toHaveLength(2);
    expect(problems.some((s) => s.startsWith("missing:"))).toBe(true);
    expect(problems.some((s) => s.startsWith("notgit:"))).toBe(true);
  });
});

// gs-251: --json emits a structured {ok, checks[]} payload.
describe("runDoctor --json", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE, { recursive: true });
    setRootDir(FIXTURE);
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  // Capture stdout from a single runDoctor invocation without
  // leaking across tests. Mirrors the pattern other CLI tests use.
  async function captureJson(
    args: Parameters<typeof runDoctor>[0],
  ): Promise<{ stdout: string; report: { ok: boolean; checks: unknown[] } }> {
    const originalLog = console.log;
    let buf = "";
    console.log = (...parts: unknown[]) => {
      buf += parts.map(String).join(" ") + "\n";
    };
    try {
      await runDoctor(args);
    } finally {
      console.log = originalLog;
    }
    // First line containing a JSON object is our payload.
    const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
    if (!line) {
      throw new Error(`no JSON line in doctor --json output: ${buf}`);
    }
    const report = JSON.parse(line);
    return { stdout: buf, report };
  }

  it("emits valid JSON with ok + checks array shape", async () => {
    const { report } = await captureJson({
      json: true,
      loadProjects: async () => [],
      exitOnFailure: false,
    });
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks as Array<{
      name: string;
      status: string;
      detail?: string;
      fixable?: boolean;
    }>) {
      expect(typeof c.name).toBe("string");
      expect(["pass", "fail", "skipped"]).toContain(c.status);
      if (c.detail !== undefined) expect(typeof c.detail).toBe("string");
      if (c.fixable !== undefined) expect(typeof c.fixable).toBe("boolean");
    }
  });

  it("exits 0 with ok:true when everything passes", async () => {
    // No projects + clean FIXTURE ⇒ no fixable issues and sanity
    // checks that iterate projects report "no projects registered".
    const { report } = await captureJson({
      json: true,
      loadProjects: async () => [],
      exitOnFailure: false,
    });
    expect(report.ok).toBe(true);
    for (const c of report.checks as Array<{ status: string }>) {
      expect(c.status).not.toBe("fail");
    }
  });

  it("exits 1 with ok:false when any check fails", async () => {
    // Plant an orphaned STOP file → orphaned-stop-file check fails.
    writeFileSync(join(FIXTURE, "STOP"), "STOP\n");
    const { report } = await captureJson({
      json: true,
      loadProjects: async () => [],
      exitOnFailure: false,
    });
    expect(report.ok).toBe(false);
    const failed = (report.checks as Array<{
      name: string;
      status: string;
      fixable?: boolean;
    }>).find((c) => c.name === "orphaned-stop-file" && c.status === "fail");
    expect(failed).toBeDefined();
    expect(failed!.fixable).toBe(true);
  });

  it("--json --fix reflects post-fix state", async () => {
    writeFileSync(join(FIXTURE, "STOP"), "STOP\n");
    const p = makeProject("alpha", "/tmp/doctor-alpha-nonexistent");
    const { report } = await captureJson({
      json: true,
      fix: true,
      assumeYes: true,
      loadProjects: async () => [p],
      exitOnFailure: false,
    });
    // STOP file should have been removed and the check should now pass.
    expect(existsSync(join(FIXTURE, "STOP"))).toBe(false);
    const stop = (report.checks as Array<{ name: string; status: string }>)
      .find((c) => c.name === "orphaned-stop-file");
    expect(stop?.status).toBe("pass");
    // Missing state dir should have been created and the category row
    // should now pass too (state/alpha/ was materialized by the fix).
    expect(existsSync(join(FIXTURE, "state", "alpha"))).toBe(true);
    const stateDir = (report.checks as Array<{ name: string; status: string }>)
      .find((c) => c.name === "state-dir-missing");
    expect(stateDir?.status).toBe("pass");
  });

  it("--json --verbose does not break the shape", async () => {
    const { report } = await captureJson({
      json: true,
      verbose: true,
      loadProjects: async () => [],
      exitOnFailure: false,
    });
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.checks)).toBe(true);
    for (const c of report.checks as Array<{ status: string }>) {
      expect(["pass", "fail", "skipped"]).toContain(c.status);
    }
  });
});
