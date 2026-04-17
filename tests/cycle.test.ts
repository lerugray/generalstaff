import { describe, expect, it } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import { existsSync } from "fs";
import {
  extractChangedFiles,
  diffSummaryStats,
  countCommitsAhead,
  preflightCleanupWorktree,
} from "../src/cycle";
import type { ProjectConfig } from "../src/types";

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test",
    path: "/tmp/test",
    priority: 1,
    engineer_command: "echo",
    verification_command: "echo",
    cycle_budget_minutes: 60,
    work_detection: "tasks_json",
    concurrency_detection: "none",
    branch: "bot/work",
    auto_merge: false,
    hands_off: ["x"],
    ...overrides,
  };
}

describe("extractChangedFiles", () => {
  it("extracts file paths from a unified diff", () => {
    const diff = [
      "diff --git a/src/main.ts b/src/main.ts",
      "index abc..def 100644",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,3 +1,4 @@",
      "+import { foo } from './foo';",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(extractChangedFiles(diff)).toEqual(["src/main.ts", "README.md"]);
  });

  it("returns empty array for empty diff", () => {
    expect(extractChangedFiles("")).toEqual([]);
  });

  it("handles renamed files (b/ path is the destination)", () => {
    const diff = "diff --git a/old-name.ts b/new-name.ts\n";
    expect(extractChangedFiles(diff)).toEqual(["new-name.ts"]);
  });

  it("handles renamed files across directories", () => {
    const diff = [
      "diff --git a/src/old/foo.ts b/src/new/foo.ts",
      "similarity index 100%",
      "rename from src/old/foo.ts",
      "rename to src/new/foo.ts",
    ].join("\n");
    expect(extractChangedFiles(diff)).toEqual(["src/new/foo.ts"]);
  });

  it("handles binary files", () => {
    const diff = [
      "diff --git a/assets/image.png b/assets/image.png",
      "index e69de29..d41d8cd 100644",
      "Binary files a/assets/image.png and b/assets/image.png differ",
    ].join("\n");
    expect(extractChangedFiles(diff)).toEqual(["assets/image.png"]);
  });

  it("handles new binary files", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..d41d8cd",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n");
    expect(extractChangedFiles(diff)).toEqual(["logo.png"]);
  });

  it("handles files with spaces in their names", () => {
    const diff = [
      "diff --git a/docs/my notes.md b/docs/my notes.md",
      "index abc..def 100644",
      "--- a/docs/my notes.md",
      "+++ b/docs/my notes.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(extractChangedFiles(diff)).toEqual(["docs/my notes.md"]);
  });

  it("handles renames where both names contain spaces", () => {
    const diff = "diff --git a/old name.ts b/new name.ts\n";
    expect(extractChangedFiles(diff)).toEqual(["new name.ts"]);
  });

  it("handles an added-only diff (--diff-filter=A) with multiple new files", () => {
    const diff = [
      "diff --git a/src/new-module.ts b/src/new-module.ts",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/src/new-module.ts",
      "@@ -0,0 +1,3 @@",
      "+export function foo() {",
      "+  return 42;",
      "+}",
      "diff --git a/docs/guide.md b/docs/guide.md",
      "new file mode 100644",
      "index 0000000..def5678",
      "--- /dev/null",
      "+++ b/docs/guide.md",
      "@@ -0,0 +1,2 @@",
      "+# Guide",
      "+Hello.",
      "diff --git a/tests/new.test.ts b/tests/new.test.ts",
      "new file mode 100644",
      "index 0000000..9876543",
      "--- /dev/null",
      "+++ b/tests/new.test.ts",
      "@@ -0,0 +1,1 @@",
      "+import { describe } from 'bun:test';",
    ].join("\n");

    expect(extractChangedFiles(diff)).toEqual([
      "src/new-module.ts",
      "docs/guide.md",
      "tests/new.test.ts",
    ]);
  });

  it("handles a mixed diff with text, binary, and spaced filenames", () => {
    const diff = [
      "diff --git a/src/main.ts b/src/main.ts",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/assets/icon.png b/assets/icon.png",
      "Binary files a/assets/icon.png and b/assets/icon.png differ",
      "diff --git a/docs/release notes.md b/docs/release notes.md",
      "--- a/docs/release notes.md",
      "+++ b/docs/release notes.md",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(extractChangedFiles(diff)).toEqual([
      "src/main.ts",
      "assets/icon.png",
      "docs/release notes.md",
    ]);
  });
});

describe("diffSummaryStats", () => {
  it("returns zeroes for empty diff", () => {
    expect(diffSummaryStats("")).toEqual({
      files_changed: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it("counts insertions, deletions, and files across a multi-file diff", () => {
    const diff = [
      "diff --git a/src/main.ts b/src/main.ts",
      "index abc..def 100644",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed line",
      "+added line one",
      "+added line two",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(diffSummaryStats(diff)).toEqual({
      files_changed: 2,
      insertions: 3,
      deletions: 2,
    });
  });

  it("ignores the +++/--- file-header lines when counting", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");

    expect(diffSummaryStats(diff)).toEqual({
      files_changed: 1,
      insertions: 1,
      deletions: 1,
    });
  });

  it("counts a pure-add diff with no deletions", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+line one",
      "+line two",
      "+line three",
    ].join("\n");

    expect(diffSummaryStats(diff)).toEqual({
      files_changed: 1,
      insertions: 3,
      deletions: 0,
    });
  });

  it("treats a rename-only diff as one file with zero insertions/deletions", () => {
    const diff = [
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 100%",
      "rename from old-name.ts",
      "rename to new-name.ts",
    ].join("\n");

    expect(diffSummaryStats(diff)).toEqual({
      files_changed: 1,
      insertions: 0,
      deletions: 0,
    });
  });

  it("counts binary files as changed without any +/- lines", () => {
    const diff = [
      "diff --git a/assets/icon.png b/assets/icon.png",
      "index e69de29..d41d8cd 100644",
      "Binary files a/assets/icon.png and b/assets/icon.png differ",
    ].join("\n");

    expect(diffSummaryStats(diff)).toEqual({
      files_changed: 1,
      insertions: 0,
      deletions: 0,
    });
  });
});

describe("countCommitsAhead", () => {
  async function initRepo(path: string): Promise<void> {
    mkdirSync(path, { recursive: true });
    await $`git -C ${path} init -b master`.quiet();
    // Isolate from global git identity / signing config so commits work in CI
    // and on machines with commit.gpgsign=true.
    await $`git -C ${path} config user.email test@example.com`.quiet();
    await $`git -C ${path} config user.name test`.quiet();
    await $`git -C ${path} config commit.gpgsign false`.quiet();
  }

  async function commitFile(
    path: string,
    file: string,
    content: string,
    message: string,
  ): Promise<void> {
    writeFileSync(join(path, file), content, "utf8");
    await $`git -C ${path} add ${file}`.quiet();
    await $`git -C ${path} commit -m ${message}`.quiet();
  }

  it("returns 0 for a branch even with master unless that branch has its own commits", async () => {
    const repo = join(tmpdir(), "gs-cca-even-" + Date.now());
    try {
      await initRepo(repo);
      await commitFile(repo, "a.txt", "one", "initial");
      await $`git -C ${repo} branch feature`.quiet();
      expect(await countCommitsAhead(repo, "feature", "master")).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns 1 when the branch has one commit not on master", async () => {
    const repo = join(tmpdir(), "gs-cca-ahead-" + Date.now());
    try {
      await initRepo(repo);
      await commitFile(repo, "a.txt", "one", "initial");
      await $`git -C ${repo} checkout -b feature`.quiet();
      await commitFile(repo, "b.txt", "two", "branch work");
      expect(await countCommitsAhead(repo, "feature", "master")).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns 0 after the branch is merged into master", async () => {
    const repo = join(tmpdir(), "gs-cca-merged-" + Date.now());
    try {
      await initRepo(repo);
      await commitFile(repo, "a.txt", "one", "initial");
      await $`git -C ${repo} checkout -b feature`.quiet();
      await commitFile(repo, "b.txt", "two", "branch work");
      await $`git -C ${repo} checkout master`.quiet();
      await $`git -C ${repo} merge --no-ff --no-edit feature`.quiet();
      expect(await countCommitsAhead(repo, "feature", "master")).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns 0 when the branch does not exist", async () => {
    const repo = join(tmpdir(), "gs-cca-missing-" + Date.now());
    try {
      await initRepo(repo);
      await commitFile(repo, "a.txt", "one", "initial");
      expect(await countCommitsAhead(repo, "nonexistent-branch", "master")).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("preflightCleanupWorktree", () => {
  async function initRepo(path: string): Promise<void> {
    mkdirSync(path, { recursive: true });
    await $`git -C ${path} init -b master`.quiet();
    await $`git -C ${path} config user.email test@example.com`.quiet();
    await $`git -C ${path} config user.name test`.quiet();
    await $`git -C ${path} config commit.gpgsign false`.quiet();
  }

  it("no-ops on a clean run (no stale worktree)", async () => {
    const repo = join(tmpdir(), "gs-pf-clean-" + Date.now());
    try {
      await initRepo(repo);
      const project = makeProject({ path: repo });
      const result = await preflightCleanupWorktree(project);
      expect(result).toEqual({ wasStale: false, removed: false });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("removes a stale .bot-worktree directory left behind by a killed cycle", async () => {
    const repo = join(tmpdir(), "gs-pf-stale-" + Date.now());
    try {
      await initRepo(repo);
      const wt = join(repo, ".bot-worktree");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "leftover.txt"), "partial work", "utf8");
      const project = makeProject({ path: repo });
      const result = await preflightCleanupWorktree(project);
      expect(result.wasStale).toBe(true);
      expect(result.removed).toBe(true);
      expect(existsSync(wt)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("warns but does not crash when the stale worktree is locked", async () => {
    const repo = join(tmpdir(), "gs-pf-locked-" + Date.now());
    try {
      await initRepo(repo);
      const wt = join(repo, ".bot-worktree");
      mkdirSync(wt, { recursive: true });
      const project = makeProject({ path: repo });
      const rmFn = () => {
        throw new Error("EBUSY: resource busy or locked");
      };
      const result = await preflightCleanupWorktree(project, rmFn);
      expect(result.wasStale).toBe(true);
      expect(result.removed).toBe(false);
      expect(result.warning).toContain("locked");
      expect(result.warning).toContain("EBUSY");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("executeCycle", () => {
  async function runEngineerExitHelper(exitCodeArg: string) {
    const helperPath = join(import.meta.dir, "helpers", "verify_engineer_exit_handling.ts");
    const proc = Bun.spawn(["bun", "run", helperPath, exitCodeArg], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(
        `Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`,
      );
    }
    const lastLine = stdout.trim().split("\n").pop()!;
    return JSON.parse(lastLine);
  }

  it("proceeds through verification and reviewer when engineer exits 0", async () => {
    const result = await runEngineerExitHelper("0");
    expect(result.engineer_exit_code).toBe(0);
    expect(result.verification_called).toBe(true);
    expect(result.reviewer_called).toBe(true);
    expect(result.final_outcome).toBe("verified");
  }, 30_000);

  it("blocks verification and reviewer when engineer exits non-zero", async () => {
    const result = await runEngineerExitHelper("1");
    expect(result.engineer_exit_code).toBe(1);
    expect(result.verification_called).toBe(false);
    expect(result.reviewer_called).toBe(false);
    expect(result.final_outcome).toBe("verification_failed");
    expect(result.reason).toContain("engineer exited abnormally");
    expect(result.reason).toContain("code=1");
  }, 30_000);

  it("blocks verification and reviewer when engineer is killed (exit=null)", async () => {
    const result = await runEngineerExitHelper("null");
    expect(result.engineer_exit_code).toBeNull();
    expect(result.verification_called).toBe(false);
    expect(result.reviewer_called).toBe(false);
    expect(result.final_outcome).toBe("verification_failed");
    expect(result.reason).toContain("engineer exited abnormally");
    expect(result.reason).toContain("code=null");
  }, 30_000);

  it("skips verification and reviewer on empty diff", async () => {
    const helperPath = join(import.meta.dir, "helpers", "verify_empty_diff_skips.ts");
    const proc = Bun.spawn(["bun", "run", helperPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(
        `Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`,
      );
    }

    const lastLine = stdout.trim().split("\n").pop()!;
    const result = JSON.parse(lastLine);
    expect(result.verification_called).toBe(false);
    expect(result.reviewer_called).toBe(false);
    expect(result.final_outcome).toBe("verified_weak");
    expect(result.reason).toContain("empty diff");
  }, 30_000);

  it("skips verification and reviewer on hands-off violation", async () => {
    const helperPath = join(import.meta.dir, "helpers", "verify_handsoff_violation_skips.ts");
    const proc = Bun.spawn(["bun", "run", helperPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(
        `Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`,
      );
    }

    const lastLine = stdout.trim().split("\n").pop()!;
    const result = JSON.parse(lastLine);
    expect(result.verification_called).toBe(false);
    expect(result.reviewer_called).toBe(false);
    expect(result.final_outcome).toBe("verification_failed");
    expect(result.reason).toContain("hands-off violation");
  }, 30_000);
});
