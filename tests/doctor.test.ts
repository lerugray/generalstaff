import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
import {
  runDoctor,
  findStateDirIssues,
  findStaleWorktreeIssues,
  findOrphanedStopFileIssue,
  findProjectPathProblems,
  checkStrandedBotCommits,
  checkProjectsYamlHasProject,
  checkProjectsYamlCustomized,
  checkStateDirWritable,
  checkReviewerProvider,
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
    // Happy path requires the gs-258 first-run checks to pass too:
    // projects.yaml present + differs from example + ≥1 project
    // registered + state_dir writable.
    const projectPath = join(FIXTURE, "real-repo");
    mkdirSync(join(projectPath, ".git"), { recursive: true });
    mkdirSync(join(FIXTURE, "state", "real"), { recursive: true });
    writeFileSync(join(FIXTURE, "projects.yaml.example"), "# example\n");
    writeFileSync(join(FIXTURE, "projects.yaml"), "# customized\n");
    const p = makeProject("real", projectPath);
    const { report } = await captureJson({
      json: true,
      loadProjects: async () => [p],
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

// gs-258: first-run sanity checks — empty projects.yaml, unmodified
// example, and unwritable state_dir each map to a pointed fix hint.
describe("gs-258 first-run sanity checks", () => {
  beforeEach(() => {
    mkdirSync(FIXTURE, { recursive: true });
    setRootDir(FIXTURE);
  });

  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("(a) empty projects list fails with register hint", () => {
    // projects.yaml exists but loaded list is empty.
    writeFileSync(join(FIXTURE, "projects.yaml"), "projects: []\n");
    const result = checkProjectsYamlHasProject(
      [],
      join(FIXTURE, "projects.yaml"),
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!).toContain("No projects registered");
    expect(result.problems[0]!).toContain("generalstaff register");
    expect(result.problems[0]!).toContain("projects.yaml.example");
  });

  it("(a) missing projects.yaml also fails with register hint", () => {
    const result = checkProjectsYamlHasProject(
      [],
      join(FIXTURE, "does-not-exist.yaml"),
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!).toContain("No projects registered");
  });

  it("(a) passes when at least one project is registered", () => {
    writeFileSync(join(FIXTURE, "projects.yaml"), "projects: [...]\n");
    const p = makeProject("alpha", "/tmp/ignored");
    const result = checkProjectsYamlHasProject(
      [p],
      join(FIXTURE, "projects.yaml"),
    );
    expect(result.problems).toEqual([]);
    expect(result.okDetail).toContain("1 project(s) registered");
  });

  it("(b) byte-identical projects.yaml fails with unmodified hint", () => {
    const example = join(FIXTURE, "projects.yaml.example");
    const yaml = join(FIXTURE, "projects.yaml");
    writeFileSync(example, "# example content\nprojects: []\n");
    writeFileSync(yaml, "# example content\nprojects: []\n");
    const result = checkProjectsYamlCustomized(yaml, example);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!).toContain(
      "projects.yaml is unmodified from the shipped example",
    );
  });

  it("(c) customized projects.yaml passes", () => {
    const example = join(FIXTURE, "projects.yaml.example");
    const yaml = join(FIXTURE, "projects.yaml");
    writeFileSync(example, "# example content\nprojects: []\n");
    writeFileSync(yaml, "# real content\nprojects: [real]\n");
    const result = checkProjectsYamlCustomized(yaml, example);
    expect(result.problems).toEqual([]);
    expect(result.okDetail).toContain("differs from shipped example");
  });

  it("(b/c) passes silently when projects.yaml is absent", () => {
    // (a) surfaces the missing-file case; (b) should not pile on.
    const example = join(FIXTURE, "projects.yaml.example");
    writeFileSync(example, "# example\n");
    const result = checkProjectsYamlCustomized(
      join(FIXTURE, "projects.yaml"),
      example,
    );
    expect(result.problems).toEqual([]);
  });

  it("(d) unwritable state_dir fails with permissions hint", () => {
    // Plant a file at <root>/state so existsSync is true but any write
    // probe underneath fails with ENOTDIR. Cross-platform equivalent of
    // chmod 0 that works on Windows CI.
    writeFileSync(join(FIXTURE, "state"), "not a directory");
    const result = checkStateDirWritable();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!).toContain("state_dir not writable");
    expect(result.problems[0]!).toContain("check permissions on");
    expect(result.problems[0]!).toContain(join(FIXTURE, "state"));
  });

  it("(c) state_dir passes when writable or auto-creatable", () => {
    mkdirSync(join(FIXTURE, "state"), { recursive: true });
    const result = checkStateDirWritable();
    expect(result.problems).toEqual([]);
    expect(result.okDetail).toContain("state_dir writable");
  });

  it("(c) state_dir passes when missing but parent is writable", () => {
    // Fresh FIXTURE — state/ doesn't exist but FIXTURE itself is writable.
    const result = checkStateDirWritable();
    expect(result.problems).toEqual([]);
    expect(result.okDetail).toContain("will be created on first write");
  });

  it("(e) clean happy-path: all three checks pass together", () => {
    const example = join(FIXTURE, "projects.yaml.example");
    const yaml = join(FIXTURE, "projects.yaml");
    writeFileSync(example, "# example\nprojects: []\n");
    writeFileSync(yaml, "# real\nprojects: [real-entry]\n");
    mkdirSync(join(FIXTURE, "state"), { recursive: true });
    const p = makeProject("alpha", "/tmp/ignored");
    expect(checkProjectsYamlHasProject([p], yaml).problems).toEqual([]);
    expect(checkProjectsYamlCustomized(yaml, example).problems).toEqual([]);
    expect(checkStateDirWritable().problems).toEqual([]);
  });
});

// gs-255: checkStrandedBotCommits surfaces auto_merge=true projects
// whose bot branch has commits ahead of HEAD — the gs-254 session-end
// flush's happy path handles this, but if it fails (conflict, dirty
// tree) work sits stranded until the user notices.
describe("checkStrandedBotCommits", () => {
  async function initRepoWithBranch(
    path: string,
    branch: string,
    extraCommits: number,
  ): Promise<void> {
    mkdirSync(path, { recursive: true });
    await $`git -C ${path} init -b master`.quiet();
    await $`git -C ${path} config user.email test@example.com`.quiet();
    await $`git -C ${path} config user.name test`.quiet();
    await $`git -C ${path} config commit.gpgsign false`.quiet();
    writeFileSync(join(path, "a.txt"), "one", "utf8");
    await $`git -C ${path} add a.txt`.quiet();
    await $`git -C ${path} commit -m initial`.quiet();
    await $`git -C ${path} checkout -b ${branch}`.quiet();
    for (let i = 0; i < extraCommits; i++) {
      writeFileSync(join(path, `b${i}.txt`), String(i), "utf8");
      await $`git -C ${path} add ${`b${i}.txt`}`.quiet();
      await $`git -C ${path} commit -m ${`branch work ${i}`}`.quiet();
    }
    await $`git -C ${path} checkout master`.quiet();
  }

  function makeAutoMergeProject(
    id: string,
    path: string,
    branch: string,
    autoMerge: boolean,
  ): ProjectConfig {
    return {
      id,
      path,
      priority: 1,
      engineer_command: "echo hi",
      verification_command: "echo ok",
      cycle_budget_minutes: 30,
      hands_off: [],
      branch,
      auto_merge: autoMerge,
    } as unknown as ProjectConfig;
  }

  it("passes when auto_merge=true project has 0 unmerged commits", async () => {
    const repo = join(tmpdir(), "gs-stranded-zero-" + Date.now());
    try {
      await initRepoWithBranch(repo, "bot/work", 0);
      const p = makeAutoMergeProject("zero", repo, "bot/work", true);
      const result = await checkStrandedBotCommits([p]);
      expect(result.problems).toEqual([]);
      expect(result.okDetail).toContain("1 auto_merge=true project(s)");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("warns with the count when project has 2 unmerged commits", async () => {
    const repo = join(tmpdir(), "gs-stranded-two-" + Date.now());
    try {
      await initRepoWithBranch(repo, "bot/work", 2);
      const p = makeAutoMergeProject("two", repo, "bot/work", true);
      const result = await checkStrandedBotCommits([p]);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!).toContain("Project two has 2 unmerged commit(s) on bot/work");
      expect(result.problems[0]!).toContain("merge --no-ff bot/work");
      expect(result.problems[0]!).toContain("gs-254 flush");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips auto_merge=false projects regardless of branch state", async () => {
    const repo = join(tmpdir(), "gs-stranded-off-" + Date.now());
    try {
      // Even with 5 unmerged commits on the bot branch, auto_merge=false
      // means bot/work is the source of truth — not a stranded state.
      await initRepoWithBranch(repo, "bot/work", 5);
      const p = makeAutoMergeProject("off", repo, "bot/work", false);
      const result = await checkStrandedBotCommits([p]);
      expect(result.problems).toEqual([]);
      expect(result.okDetail).toContain("no auto_merge=true projects");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips non-git paths gracefully", async () => {
    const missingPath = join(tmpdir(), "gs-stranded-missing-" + Date.now());
    const notGitPath = join(tmpdir(), "gs-stranded-notgit-" + Date.now());
    mkdirSync(notGitPath, { recursive: true });
    try {
      const missing = makeAutoMergeProject("missing", missingPath, "bot/work", true);
      const notGit = makeAutoMergeProject("notgit", notGitPath, "bot/work", true);
      const result = await checkStrandedBotCommits([missing, notGit]);
      // Both paths are skipped before git is invoked, so no problems
      // are reported and neither project counts toward relevantCount.
      expect(result.problems).toEqual([]);
      expect(result.okDetail).toContain("no auto_merge=true projects");
    } finally {
      rmSync(notGitPath, { recursive: true, force: true });
    }
  });
});

describe("checkReviewerProvider (gs-263)", () => {
  it("reports claude provider as PASS when no env is set", () => {
    const result = checkReviewerProvider({});
    expect(result.status).toBe("pass");
    expect(result.provider).toBe("claude");
    expect(result.detail).toBe("reviewer: claude");
  });

  it("reports openrouter with model as PASS when key is set", () => {
    const result = checkReviewerProvider({
      GENERALSTAFF_REVIEWER_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
    });
    expect(result.status).toBe("pass");
    expect(result.provider).toBe("openrouter");
    expect(result.detail).toContain("reviewer: openrouter");
    expect(result.detail).toContain("model:");
    expect(result.detail).toContain("qwen/qwen3-coder-30b-a3b-instruct");
    expect(result.detail).not.toContain("OPENROUTER_API_KEY");
  });

  it("honors GENERALSTAFF_REVIEWER_MODEL override for openrouter", () => {
    const result = checkReviewerProvider({
      GENERALSTAFF_REVIEWER_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      GENERALSTAFF_REVIEWER_MODEL: "qwen/qwen3-coder-plus",
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("qwen/qwen3-coder-plus");
  });

  it("reports openrouter without key as WARN", () => {
    const result = checkReviewerProvider({
      GENERALSTAFF_REVIEWER_PROVIDER: "openrouter",
    });
    expect(result.status).toBe("warn");
    expect(result.provider).toBe("openrouter");
    expect(result.detail).toContain("OPENROUTER_API_KEY not set");
    expect(result.detail).toContain("verification_failed");
  });

  it("reports ollama as PASS with OLLAMA_HOST default", () => {
    const result = checkReviewerProvider({
      GENERALSTAFF_REVIEWER_PROVIDER: "ollama",
    });
    expect(result.status).toBe("pass");
    expect(result.provider).toBe("ollama");
    expect(result.detail).toContain("reviewer: ollama");
    expect(result.detail).toContain("OLLAMA_HOST:");
    expect(result.detail).toContain("http://localhost:11434");
    expect(result.detail).toContain("model:");
    expect(result.detail).toContain("qwen3:8b");
  });

  it("reports ollama with custom OLLAMA_HOST and model override", () => {
    const result = checkReviewerProvider({
      GENERALSTAFF_REVIEWER_PROVIDER: "ollama",
      OLLAMA_HOST: "http://10.0.0.5:11434",
      GENERALSTAFF_REVIEWER_MODEL: "llama3:70b",
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("http://10.0.0.5:11434");
    expect(result.detail).toContain("llama3:70b");
  });

  it("normalizes uppercase provider to lowercase", () => {
    const result = checkReviewerProvider({
      GENERALSTAFF_REVIEWER_PROVIDER: "OpenRouter",
      OPENROUTER_API_KEY: "sk-or-test",
    });
    expect(result.provider).toBe("openrouter");
    expect(result.status).toBe("pass");
  });
});
