import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  catalogdnaHasMoreWork,
  greenfieldHasMoreWork,
  catalogdnaCountRemaining,
  greenfieldCountRemaining,
  countRemainingWork,
  countRemainingWorkDetailed,
  greenfieldCountRemainingDetailed,
  hasMoreWork,
  gitIssuesCountRemaining,
  gitIssuesHasMoreWork,
  gitUnmergedCountRemaining,
  gitUnmergedHasMoreWork,
} from "../src/work_detection";
import type { ProjectConfig } from "../src/types";
import { setRootDir } from "../src/state";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const FIXTURES = join(import.meta.dir, "fixtures", "work_detection");

function writeFixture(relativePath: string, content: string) {
  const fullPath = join(FIXTURES, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  setRootDir(FIXTURES);
});

afterEach(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

describe("catalogdnaHasMoreWork", () => {
  it("returns true when P0-P3 have unchecked items", async () => {
    const projectPath = join(FIXTURES, "project-a");
    writeFixture(
      "project-a/bot_tasks.md",
      `# Bot Tasks — Run 23

## P0 — Critical bugs
- [ ] Fix the login crash
- [x] Handle null pointer

## P1 — High priority
- [x] Add caching

## Phase A — self-directed
- [ ] This should not count
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(true);
  });

  it("returns false when all P0-P3 items are checked", async () => {
    const projectPath = join(FIXTURES, "project-b");
    writeFixture(
      "project-b/bot_tasks.md",
      `# Bot Tasks

## P0 — Critical
- [x] All done

## P1 — High
- [x] Also done
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(false);
  });

  it("skips COMPLETED sections", async () => {
    const projectPath = join(FIXTURES, "project-c");
    writeFixture(
      "project-c/bot_tasks.md",
      `# Bot Tasks

## P0 — COMPLETED INTERACTIVELY — SKIP
- [ ] This unchecked item should be ignored

## P1 — High
- [x] Done
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(false);
  });

  it("returns false when bot_tasks.md doesn't exist", async () => {
    expect(await catalogdnaHasMoreWork(join(FIXTURES, "nonexistent"))).toBe(
      false,
    );
  });

  it("ignores Phase A/B sections", async () => {
    const projectPath = join(FIXTURES, "project-d");
    writeFixture(
      "project-d/bot_tasks.md",
      `# Bot Tasks

## Phase A — Self-directed
- [ ] Explore codebase
- [ ] Refactor utils

## Phase B — Stretch
- [ ] Add metrics
`,
    );
    expect(await catalogdnaHasMoreWork(projectPath)).toBe(false);
  });
});

describe("greenfieldHasMoreWork", () => {
  it("returns true when tasks.json has pending items", async () => {
    writeFixture(
      "state/greenfield/tasks.json",
      JSON.stringify([
        { id: "1", title: "Task 1", status: "done", priority: 1 },
        { id: "2", title: "Task 2", status: "pending", priority: 2 },
      ]),
    );
    expect(await greenfieldHasMoreWork(FIXTURES, "greenfield")).toBe(true);
  });

  it("returns false when all tasks are done", async () => {
    writeFixture(
      "state/all-done/tasks.json",
      JSON.stringify([
        { id: "1", title: "Task 1", status: "done", priority: 1 },
        { id: "2", title: "Task 2", status: "skipped", priority: 2 },
      ]),
    );
    expect(await greenfieldHasMoreWork(FIXTURES, "all-done")).toBe(false);
  });

  it("returns true when tasks include in_progress items", async () => {
    writeFixture(
      "state/in-prog/tasks.json",
      JSON.stringify([
        { id: "1", title: "Task 1", status: "done", priority: 1 },
        { id: "2", title: "Task 2", status: "in_progress", priority: 2 },
        { id: "3", title: "Task 3", status: "skipped", priority: 3 },
      ]),
    );
    expect(await greenfieldHasMoreWork(FIXTURES, "in-prog")).toBe(true);
  });

  it("returns false when tasks.json doesn't exist", async () => {
    expect(await greenfieldHasMoreWork(FIXTURES, "nonexistent")).toBe(false);
  });
});

describe("catalogdnaCountRemaining", () => {
  it("counts unchecked items across P0-P3 sections", async () => {
    const projectPath = join(FIXTURES, "count-a");
    writeFixture(
      "count-a/bot_tasks.md",
      `# Bot Tasks

## P0 — Critical
- [ ] First
- [ ] Second
- [x] Done

## P1 — High
- [ ] Third

## Phase A — should not count
- [ ] Ignore me
`,
    );
    expect(await catalogdnaCountRemaining(projectPath)).toBe(3);
  });

  it("returns 0 when all items are checked", async () => {
    const projectPath = join(FIXTURES, "count-b");
    writeFixture(
      "count-b/bot_tasks.md",
      `# Bot Tasks

## P0
- [x] Done
- [x] Also done
`,
    );
    expect(await catalogdnaCountRemaining(projectPath)).toBe(0);
  });

  it("skips COMPLETED sections", async () => {
    const projectPath = join(FIXTURES, "count-c");
    writeFixture(
      "count-c/bot_tasks.md",
      `# Bot Tasks

## P0 — COMPLETED
- [ ] ignored

## P1
- [ ] counted
`,
    );
    expect(await catalogdnaCountRemaining(projectPath)).toBe(1);
  });

  it("returns 0 when file doesn't exist", async () => {
    expect(
      await catalogdnaCountRemaining(join(FIXTURES, "nope")),
    ).toBe(0);
  });
});

describe("greenfieldCountRemaining", () => {
  it("counts tasks that are not done or skipped", async () => {
    writeFixture(
      "state/count-green/tasks.json",
      JSON.stringify([
        { id: "1", status: "done" },
        { id: "2", status: "pending" },
        { id: "3", status: "in_progress" },
        { id: "4", status: "skipped" },
        { id: "5", status: "pending" },
      ]),
    );
    expect(await greenfieldCountRemaining(FIXTURES, "count-green")).toBe(3);
  });

  it("returns 0 when all tasks are done or skipped", async () => {
    writeFixture(
      "state/count-done/tasks.json",
      JSON.stringify([
        { id: "1", status: "done" },
        { id: "2", status: "skipped" },
      ]),
    );
    expect(await greenfieldCountRemaining(FIXTURES, "count-done")).toBe(0);
  });

  it("returns 0 when tasks.json doesn't exist", async () => {
    expect(await greenfieldCountRemaining(FIXTURES, "nonexistent")).toBe(0);
  });

  it("returns 0 when JSON is malformed", async () => {
    writeFixture("state/count-bad/tasks.json", "{ not json");
    expect(await greenfieldCountRemaining(FIXTURES, "count-bad")).toBe(0);
  });

  it("reads from project.path (non-dogfood), not getRootDir()", async () => {
    // Proves the Phase 3 fix: when project.path differs from getRootDir(),
    // greenfieldCountRemaining must read from project.path, not the
    // GeneralStaff repo root.
    const projectPath = join(FIXTURES, "external-project");
    mkdirSync(join(projectPath, "state", "gamr"), { recursive: true });
    writeFileSync(
      join(projectPath, "state", "gamr", "tasks.json"),
      JSON.stringify([
        { id: "1", status: "pending" },
        { id: "2", status: "pending" },
        { id: "3", status: "done" },
      ]),
      "utf8",
    );

    // Also write a decoy tasks.json under the fake GeneralStaff root that,
    // if the old code path ran, would return a different count. This ensures
    // we're reading from projectPath and not falling back to the root.
    writeFixture(
      "state/gamr/tasks.json",
      JSON.stringify([{ id: "x", status: "pending" }]),
    );

    expect(await greenfieldCountRemaining(projectPath, "gamr")).toBe(2);
    expect(await greenfieldHasMoreWork(projectPath, "gamr")).toBe(true);
  });

  // gs-195: hands_off-aware filtering. Tasks that collide with the
  // project's hands_off list or are marked interactive_only should
  // not contribute to the "bot has work left to do" signal.
  it("skips interactive_only tasks when counting bot work", async () => {
    writeFixture(
      "state/gs-195-io/tasks.json",
      JSON.stringify([
        { id: "1", title: "t1", status: "pending", priority: 1 },
        {
          id: "2",
          title: "t2",
          status: "pending",
          priority: 1,
          interactive_only: true,
        },
      ]),
    );
    // interactive_only is filtered regardless of hands_off.
    expect(await greenfieldCountRemaining(FIXTURES, "gs-195-io")).toBe(1);
    expect(await greenfieldCountRemaining(FIXTURES, "gs-195-io", [])).toBe(1);
    expect(
      await greenfieldCountRemaining(FIXTURES, "gs-195-io", ["unrelated/**"]),
    ).toBe(1);
  });

  it("skips tasks whose expected_touches collide with hands_off", async () => {
    writeFixture(
      "state/gs-195-ho/tasks.json",
      JSON.stringify([
        {
          id: "ok",
          title: "safe",
          status: "pending",
          priority: 1,
          expected_touches: ["src/cli.ts", "tests/unit/test_cli.ts"],
        },
        {
          id: "bad",
          title: "touches hands_off",
          status: "pending",
          priority: 1,
          expected_touches: ["src/raybrain/schema/models.py"],
        },
      ]),
    );
    // No hands_off: both pick.
    expect(await greenfieldCountRemaining(FIXTURES, "gs-195-ho", [])).toBe(2);
    // With hands_off: 'bad' is filtered out.
    expect(
      await greenfieldCountRemaining(FIXTURES, "gs-195-ho", [
        "src/*/schema/**",
      ]),
    ).toBe(1);
    expect(
      await greenfieldHasMoreWork(FIXTURES, "gs-195-ho", [
        "src/cli.ts",
        "tests/**",
        "src/*/schema/**",
      ]),
    ).toBe(false);
  });
});

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

function setupRepoWithUpstream(name: string, commitsAhead: number): string {
  const remoteDir = join(FIXTURES, `${name}-remote.git`);
  const workDir = join(FIXTURES, name);
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  // Bare upstream repo (acts as "origin")
  git(remoteDir, ["init", "--bare", "--initial-branch=master"]);

  // Working repo with one shared commit pushed upstream
  git(workDir, ["init", "--initial-branch=master"]);
  git(workDir, ["config", "user.email", "test@test.com"]);
  git(workDir, ["config", "user.name", "Test"]);
  writeFileSync(join(workDir, "README.md"), "initial\n");
  git(workDir, ["add", "README.md"]);
  git(workDir, ["commit", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", remoteDir]);
  git(workDir, ["push", "origin", "master"]);

  // Add commits that are ahead of origin/master
  for (let i = 0; i < commitsAhead; i++) {
    writeFileSync(join(workDir, `file-${i}.txt`), `change ${i}\n`);
    git(workDir, ["add", `file-${i}.txt`]);
    git(workDir, ["commit", "-m", `change ${i}`]);
  }

  return workDir;
}

describe("gitIssuesCountRemaining", () => {
  it("counts commits ahead of origin/master", async () => {
    const workDir = setupRepoWithUpstream("git-ahead-3", 3);
    expect(await gitIssuesCountRemaining(workDir)).toBe(3);
  });

  it("returns 0 when HEAD is at origin/master", async () => {
    const workDir = setupRepoWithUpstream("git-ahead-0", 0);
    expect(await gitIssuesCountRemaining(workDir)).toBe(0);
  });

  it("returns 0 when origin/master is missing (no remote)", async () => {
    const workDir = join(FIXTURES, "git-no-remote");
    mkdirSync(workDir, { recursive: true });
    git(workDir, ["init", "--initial-branch=master"]);
    git(workDir, ["config", "user.email", "test@test.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    writeFileSync(join(workDir, "f.txt"), "x\n");
    git(workDir, ["add", "f.txt"]);
    git(workDir, ["commit", "-m", "only commit"]);
    expect(await gitIssuesCountRemaining(workDir)).toBe(0);
  });

  it("returns 0 when path is not a git repo", async () => {
    const notRepo = join(FIXTURES, "not-a-repo");
    mkdirSync(notRepo, { recursive: true });
    expect(await gitIssuesCountRemaining(notRepo)).toBe(0);
  });
});

describe("gitIssuesHasMoreWork", () => {
  it("returns true when commits are ahead of origin/master", async () => {
    const workDir = setupRepoWithUpstream("git-has-2", 2);
    expect(await gitIssuesHasMoreWork(workDir)).toBe(true);
  });

  it("returns false when no commits are ahead", async () => {
    const workDir = setupRepoWithUpstream("git-has-0", 0);
    expect(await gitIssuesHasMoreWork(workDir)).toBe(false);
  });
});

function setupRepoWithBranch(
  name: string,
  branchCommitsAhead: number,
  branchName = "bot/work",
): string {
  const workDir = join(FIXTURES, name);
  mkdirSync(workDir, { recursive: true });

  git(workDir, ["init", "--initial-branch=master"]);
  git(workDir, ["config", "user.email", "test@test.com"]);
  git(workDir, ["config", "user.name", "Test"]);
  writeFileSync(join(workDir, "README.md"), "initial\n");
  git(workDir, ["add", "README.md"]);
  git(workDir, ["commit", "-m", "initial"]);

  git(workDir, ["checkout", "-b", branchName]);
  for (let i = 0; i < branchCommitsAhead; i++) {
    writeFileSync(join(workDir, `f-${i}.txt`), `x ${i}\n`);
    git(workDir, ["add", `f-${i}.txt`]);
    git(workDir, ["commit", "-m", `bot change ${i}`]);
  }
  return workDir;
}

describe("gitUnmergedCountRemaining", () => {
  it("counts branch commits ahead of master", async () => {
    const workDir = setupRepoWithBranch("unmerged-3", 3);
    expect(await gitUnmergedCountRemaining(workDir, "bot/work")).toBe(3);
  });

  it("returns 0 when branch is at master", async () => {
    const workDir = setupRepoWithBranch("unmerged-0", 0);
    expect(await gitUnmergedCountRemaining(workDir, "bot/work")).toBe(0);
  });

  it("returns 0 when the branch doesn't exist", async () => {
    const workDir = setupRepoWithBranch("unmerged-nobranch", 0);
    expect(
      await gitUnmergedCountRemaining(workDir, "nonexistent-branch"),
    ).toBe(0);
  });

  it("returns 0 when path is not a git repo", async () => {
    const notRepo = join(FIXTURES, "unmerged-not-a-repo");
    mkdirSync(notRepo, { recursive: true });
    expect(await gitUnmergedCountRemaining(notRepo, "bot/work")).toBe(0);
  });
});

describe("gitUnmergedHasMoreWork", () => {
  it("returns true when branch has commits ahead of master", async () => {
    const workDir = setupRepoWithBranch("unmerged-has-2", 2);
    expect(await gitUnmergedHasMoreWork(workDir, "bot/work")).toBe(true);
  });

  it("returns false when branch has no commits ahead", async () => {
    const workDir = setupRepoWithBranch("unmerged-has-0", 0);
    expect(await gitUnmergedHasMoreWork(workDir, "bot/work")).toBe(false);
  });
});

describe("countRemainingWork", () => {
  function makeProject(
    overrides: Partial<ProjectConfig> & Pick<ProjectConfig, "work_detection">,
  ): ProjectConfig {
    return {
      id: "proj",
      path: FIXTURES,
      priority: 1,
      engineer_command: "",
      verification_command: "",
      cycle_budget_minutes: 10,
      concurrency_detection: "none",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
      ...overrides,
    };
  }

  it("dispatches to catalogdna mode", async () => {
    const projectPath = join(FIXTURES, "dispatch-cat");
    writeFixture(
      "dispatch-cat/bot_tasks.md",
      `## P0\n- [ ] a\n- [ ] b\n`,
    );
    const project = makeProject({
      work_detection: "catalogdna_bot_tasks",
      path: projectPath,
    });
    expect(await countRemainingWork(project)).toBe(2);
  });

  it("dispatches to tasks_json mode", async () => {
    writeFixture(
      "state/dispatch-green/tasks.json",
      JSON.stringify([
        { id: "1", status: "pending" },
        { id: "2", status: "done" },
      ]),
    );
    const project = makeProject({
      id: "dispatch-green",
      work_detection: "tasks_json",
    });
    expect(await countRemainingWork(project)).toBe(1);
  });

  it("dispatches to git_issues mode", async () => {
    const workDir = setupRepoWithUpstream("dispatch-git", 2);
    const project = makeProject({
      work_detection: "git_issues",
      path: workDir,
    });
    expect(await countRemainingWork(project)).toBe(2);
  });

  it("dispatches to git_unmerged mode", async () => {
    const workDir = setupRepoWithBranch("dispatch-unmerged", 2);
    const project = makeProject({
      work_detection: "git_unmerged",
      path: workDir,
      branch: "bot/work",
    });
    expect(await countRemainingWork(project)).toBe(2);
  });

  it("returns 0 for an unknown work_detection mode (fail-safe)", async () => {
    const project = makeProject({
      work_detection: "bogus_mode" as unknown as ProjectConfig["work_detection"],
    });
    expect(await countRemainingWork(project)).toBe(0);
  });
});

// gs-200: countRemainingWorkDetailed — structured breakdown of
// pending/in_progress/done/skipped with the three "pending" buckets
// (bot-pickable vs. interactive_only vs. hands_off_intersect).
describe("countRemainingWorkDetailed", () => {
  function makeProject(
    overrides: Partial<ProjectConfig> & Pick<ProjectConfig, "work_detection">,
  ): ProjectConfig {
    return {
      id: "proj",
      path: FIXTURES,
      priority: 1,
      engineer_command: "",
      verification_command: "",
      cycle_budget_minutes: 10,
      concurrency_detection: "none",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
      ...overrides,
    };
  }

  it("buckets pending tasks across bot_pickable / interactive_only / hands_off_intersect", async () => {
    writeFixture(
      "state/gs-200-mix/tasks.json",
      JSON.stringify([
        { id: "1", title: "plain pending", status: "pending", priority: 1 },
        {
          id: "2",
          title: "pending with safe expected_touches",
          status: "pending",
          priority: 1,
          expected_touches: ["src/cli.ts"],
        },
        {
          id: "3",
          title: "interactive-only",
          status: "pending",
          priority: 1,
          interactive_only: true,
        },
        {
          id: "4",
          title: "conflicts with hands_off",
          status: "pending",
          priority: 1,
          expected_touches: ["src/prompts/engineer.md"],
        },
        { id: "5", title: "running", status: "in_progress", priority: 1 },
        { id: "6", title: "done", status: "done", priority: 1 },
        { id: "7", title: "skipped", status: "skipped", priority: 1 },
      ]),
    );
    const project = makeProject({
      id: "gs-200-mix",
      work_detection: "tasks_json",
      hands_off: ["src/prompts/**"],
    });

    const b = await countRemainingWorkDetailed(project);
    expect(b.pending_bot_pickable).toBe(2);
    expect(b.pending_interactive_only).toBe(1);
    expect(b.pending_handsoff_conflict).toBe(1);
    expect(b.in_progress).toBe(1);
    expect(b.done).toBe(1);
    expect(b.skipped).toBe(1);
    expect(b.total).toBe(7);
  });

  it("gs-231: status='completed' counts in the done bucket, not pending_bot_pickable", async () => {
    // gs-215 was marked `completed` by the bot before the status enum
    // was locked down. greenfieldCountRemainingDetailed bypasses the
    // validator by casting JSON.parse output directly, so `"completed"`
    // can survive — it should be bucketed as terminal/done rather than
    // leaking back into pending_bot_pickable.
    writeFixture(
      "state/gs-231-completed/tasks.json",
      JSON.stringify([
        { id: "1", title: "plain pending", status: "pending", priority: 1 },
        { id: "2", title: "legacy", status: "completed", priority: 1 },
        { id: "3", title: "done", status: "done", priority: 1 },
      ]),
    );
    const project = makeProject({
      id: "gs-231-completed",
      work_detection: "tasks_json",
    });
    const b = await countRemainingWorkDetailed(project);
    expect(b.done).toBe(2);
    expect(b.pending_bot_pickable).toBe(1);
    expect(b.pending_interactive_only).toBe(0);
    expect(b.pending_handsoff_conflict).toBe(0);
    expect(b.total).toBe(3);
  });

  it("returns an all-zero breakdown when tasks.json is missing", async () => {
    const project = makeProject({
      id: "gs-200-missing",
      work_detection: "tasks_json",
    });
    const b = await countRemainingWorkDetailed(project);
    expect(b.pending_bot_pickable).toBe(0);
    expect(b.pending_interactive_only).toBe(0);
    expect(b.pending_handsoff_conflict).toBe(0);
    expect(b.in_progress).toBe(0);
    expect(b.done).toBe(0);
    expect(b.skipped).toBe(0);
    expect(b.total).toBe(0);
  });

  it("returns an all-zero breakdown on malformed tasks.json", async () => {
    writeFixture("state/gs-200-bad/tasks.json", "{ not json");
    const project = makeProject({
      id: "gs-200-bad",
      work_detection: "tasks_json",
    });
    const b = await countRemainingWorkDetailed(project);
    expect(b.total).toBe(0);
    expect(b.pending_bot_pickable).toBe(0);
  });

  it("delegates to greenfieldCountRemainingDetailed for tasks_json mode", async () => {
    writeFixture(
      "state/gs-200-direct/tasks.json",
      JSON.stringify([
        { id: "1", status: "pending", priority: 1, title: "a" },
        {
          id: "2",
          status: "pending",
          priority: 1,
          title: "b",
          interactive_only: true,
        },
      ]),
    );
    const direct = await greenfieldCountRemainingDetailed(
      FIXTURES,
      "gs-200-direct",
      [],
    );
    expect(direct.pending_bot_pickable).toBe(1);
    expect(direct.pending_interactive_only).toBe(1);
    expect(direct.total).toBe(2);
  });

  it("for catalogdna mode, puts the full count into pending_bot_pickable with refinement fields zeroed", async () => {
    const projectPath = join(FIXTURES, "gs-200-cat");
    writeFixture(
      "gs-200-cat/bot_tasks.md",
      `## P0\n- [ ] one\n- [ ] two\n- [x] done\n`,
    );
    const project = makeProject({
      work_detection: "catalogdna_bot_tasks",
      path: projectPath,
    });
    const b = await countRemainingWorkDetailed(project);
    expect(b.pending_bot_pickable).toBe(2);
    expect(b.pending_interactive_only).toBe(0);
    expect(b.pending_handsoff_conflict).toBe(0);
    expect(b.in_progress).toBe(0);
    expect(b.done).toBe(0);
    expect(b.skipped).toBe(0);
    expect(b.total).toBe(2);
  });

  it("for git_unmerged mode, puts the branch-ahead count into pending_bot_pickable", async () => {
    const workDir = setupRepoWithBranch("gs-200-unmerged", 2);
    const project = makeProject({
      work_detection: "git_unmerged",
      path: workDir,
      branch: "bot/work",
    });
    const b = await countRemainingWorkDetailed(project);
    expect(b.pending_bot_pickable).toBe(2);
    expect(b.pending_interactive_only).toBe(0);
    expect(b.pending_handsoff_conflict).toBe(0);
    expect(b.total).toBe(2);
  });

  it("returns an all-zero breakdown for an unknown work_detection mode", async () => {
    const project = makeProject({
      work_detection:
        "nope_mode" as unknown as ProjectConfig["work_detection"],
    });
    const b = await countRemainingWorkDetailed(project);
    expect(b.total).toBe(0);
    expect(b.pending_bot_pickable).toBe(0);
  });
});

describe("hasMoreWork unknown-mode fallback", () => {
  function makeProject(
    overrides: Partial<ProjectConfig> & Pick<ProjectConfig, "work_detection">,
  ): ProjectConfig {
    return {
      id: "proj",
      path: FIXTURES,
      priority: 1,
      engineer_command: "",
      verification_command: "",
      cycle_budget_minutes: 10,
      concurrency_detection: "none",
      branch: "bot/work",
      auto_merge: false,
      hands_off: [],
      ...overrides,
    };
  }

  it("returns false for an unknown work_detection mode (fail-safe)", async () => {
    const project = makeProject({
      work_detection: "not_a_mode" as unknown as ProjectConfig["work_detection"],
    });
    expect(await hasMoreWork(project)).toBe(false);
  });
});
