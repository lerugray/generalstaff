import { describe, expect, it } from "bun:test";
import { join, resolve as resolvePath } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import { existsSync } from "fs";
import {
  extractChangedFiles,
  diffSummaryStats,
  countCommitsAhead,
  preflightCleanupWorktree,
  formatUnmergedBranchError,
  crossCheckReviewerHandsOff,
  applyReviewerSanityCheck,
  decideBotBranchHandling,
  detectMalformedJsonFiles,
} from "../src/cycle";
import type { ProjectConfig, ReviewerResponse } from "../src/types";
import type { ReviewerResult } from "../src/reviewer";

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
      expect(result.warning).toContain("locked by another process");
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

  it("routes to cycle_skipped when STOP file appears mid-engineer (gs-131)", async () => {
    const helperPath = join(import.meta.dir, "helpers", "verify_stop_mid_cycle.ts");
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
    expect(result.engineer_exit_code).toBeNull();
    expect(result.verification_called).toBe(false);
    expect(result.reviewer_called).toBe(false);
    expect(result.final_outcome).toBe("cycle_skipped");
    expect(result.reason).toContain("STOP file triggered during engineer");
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

describe("cycle rollback on verification_failed (gs-132)", () => {
  async function runRollbackHelper(scenarioArg: string) {
    const helperPath = join(import.meta.dir, "helpers", "verify_rollback_behavior.ts");
    const proc = Bun.spawn(["bun", "run", helperPath, scenarioArg], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`Helper failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    }
    const lastLine = stdout.trim().split("\n").pop()!;
    return JSON.parse(lastLine);
  }

  it("rolls back bot/work to start_sha when verification_failed with non-empty diff", async () => {
    const result = await runRollbackHelper("verification_failed");
    expect(result.final_outcome).toBe("verification_failed");
    expect(result.reviewer_called).toBe(true);
    expect(result.cycle_end_sha).toBe(result.cycle_start_sha);
    expect(result.branch_sha_after).toBe(result.cycle_start_sha);
    expect(result.rollback_event_count).toBe(1);
    expect(result.rollback_after_sha).toBe(result.cycle_start_sha);
    expect(result.rollback_before_sha).not.toBe(result.cycle_start_sha);
  }, 30_000);

  it("does not roll back on verified cycle", async () => {
    const result = await runRollbackHelper("verified");
    expect(result.final_outcome).toBe("verified");
    expect(result.reviewer_called).toBe(true);
    expect(result.cycle_end_sha).not.toBe(result.cycle_start_sha);
    expect(result.branch_sha_after).toBe(result.cycle_end_sha);
    expect(result.rollback_event_count).toBe(0);
  }, 30_000);

  it("does not roll back on verified_weak cycle", async () => {
    const result = await runRollbackHelper("verified_weak");
    expect(result.final_outcome).toBe("verified_weak");
    expect(result.reviewer_called).toBe(true);
    expect(result.cycle_end_sha).not.toBe(result.cycle_start_sha);
    expect(result.branch_sha_after).toBe(result.cycle_end_sha);
    expect(result.rollback_event_count).toBe(0);
  }, 30_000);

  it("does not roll back when diff is empty (start_sha === end_sha)", async () => {
    const result = await runRollbackHelper("empty_diff");
    expect(result.final_outcome).toBe("verified_weak");
    expect(result.reviewer_called).toBe(false);
    expect(result.cycle_end_sha).toBe(result.cycle_start_sha);
    expect(result.rollback_event_count).toBe(0);
  }, 30_000);
});

describe("reviewer hands_off_violations sanity check (gs-133)", () => {
  function makeReviewerResult(overrides: Partial<ReviewerResponse> = {}): ReviewerResult {
    const response: ReviewerResponse = {
      verdict: "verification_failed",
      reason: "hands-off violation",
      scope_drift_files: [],
      hands_off_violations: [],
      task_evidence: [],
      silent_failures: [],
      notes: "",
      ...overrides,
    };
    return {
      verdict: response.verdict,
      response,
      rawResponse: "{}",
      parseError: null,
    };
  }

  describe("crossCheckReviewerHandsOff", () => {
    it("keeps a violation that names a file actually in the diff", () => {
      const result = crossCheckReviewerHandsOff(
        ["src/safety.ts"],
        ["src/safety.ts", "src/cycle.ts"],
      );
      expect(result.real).toEqual(["src/safety.ts"]);
      expect(result.dropped).toEqual([]);
    });

    it("drops a violation that names a file NOT in the diff", () => {
      const result = crossCheckReviewerHandsOff(
        ["src/safety.ts"],
        ["src/engineer.ts", "src/cycle.ts"],
      );
      expect(result.real).toEqual([]);
      expect(result.dropped).toEqual(["src/safety.ts"]);
    });

    it("keeps a glob-style violation that matches a changed file", () => {
      // The reviewer frequently emits a prefix like src/prompts/; this
      // must still match src/prompts/reviewer.ts for parity with the
      // cycle's hands-off gate.
      const result = crossCheckReviewerHandsOff(
        ["src/prompts/"],
        ["src/prompts/reviewer.ts"],
      );
      expect(result.real).toEqual(["src/prompts/"]);
      expect(result.dropped).toEqual([]);
    });

    it("splits mixed real + hallucinated violations", () => {
      const result = crossCheckReviewerHandsOff(
        ["src/safety.ts", "src/cycle.ts", "src/prompts/"],
        ["src/cycle.ts", "src/engineer.ts"],
      );
      expect(result.real).toEqual(["src/cycle.ts"]);
      expect(result.dropped).toEqual(["src/safety.ts", "src/prompts/"]);
    });

    it("returns empty lists when reviewer reported nothing", () => {
      const result = crossCheckReviewerHandsOff([], ["src/cycle.ts"]);
      expect(result.real).toEqual([]);
      expect(result.dropped).toEqual([]);
    });
  });

  describe("applyReviewerSanityCheck", () => {
    it("(a) reviewer reports a file IS in the diff — violation stands, verdict unchanged", () => {
      const rr = makeReviewerResult({
        verdict: "verification_failed",
        hands_off_violations: ["src/safety.ts"],
      });
      const outcome = applyReviewerSanityCheck(rr, ["src/safety.ts", "src/cycle.ts"]);
      expect(outcome.dropped).toEqual([]);
      expect(outcome.flipped).toBe(false);
      expect(rr.verdict).toBe("verification_failed");
      expect(rr.response!.hands_off_violations).toEqual(["src/safety.ts"]);
    });

    it("(b) reviewer reports a file NOT in the diff — violation dropped, hallucination flagged", () => {
      const rr = makeReviewerResult({
        verdict: "verification_failed",
        hands_off_violations: ["src/safety.ts"],
        scope_drift_files: ["something.ts"], // prevents the flip
      });
      const outcome = applyReviewerSanityCheck(rr, ["src/engineer.ts"]);
      expect(outcome.dropped).toEqual(["src/safety.ts"]);
      // flip blocked by scope_drift_files
      expect(outcome.flipped).toBe(false);
      expect(rr.verdict).toBe("verification_failed");
      expect(rr.response!.hands_off_violations).toEqual([]);
    });

    it("(c) all violations hallucinated AND no other failures — verdict flips to verified", () => {
      const rr = makeReviewerResult({
        verdict: "verification_failed",
        hands_off_violations: ["src/safety.ts", "src/reviewer.ts", "src/prompts/"],
      });
      const outcome = applyReviewerSanityCheck(rr, [
        "src/engineer.ts",
        "src/cycle.ts",
      ]);
      expect(outcome.dropped).toEqual([
        "src/safety.ts",
        "src/reviewer.ts",
        "src/prompts/",
      ]);
      expect(outcome.flipped).toBe(true);
      expect(rr.verdict).toBe("verified");
      expect(rr.response!.verdict).toBe("verified");
      expect(rr.response!.hands_off_violations).toEqual([]);
      expect(rr.response!.reason).toContain("hallucinated");
    });

    it("(d) mixed real + hallucinated — real stands, hallucinated dropped, no flip", () => {
      const rr = makeReviewerResult({
        verdict: "verification_failed",
        hands_off_violations: ["src/cycle.ts", "src/safety.ts"],
      });
      const outcome = applyReviewerSanityCheck(rr, ["src/cycle.ts"]);
      expect(outcome.dropped).toEqual(["src/safety.ts"]);
      expect(outcome.flipped).toBe(false);
      expect(rr.verdict).toBe("verification_failed");
      expect(rr.response!.hands_off_violations).toEqual(["src/cycle.ts"]);
    });

    it("does not flip when silent_failures is non-empty", () => {
      const rr = makeReviewerResult({
        verdict: "verification_failed",
        hands_off_violations: ["src/safety.ts"],
        silent_failures: ["tests skipped"],
      });
      const outcome = applyReviewerSanityCheck(rr, ["src/cycle.ts"]);
      expect(outcome.dropped).toEqual(["src/safety.ts"]);
      expect(outcome.flipped).toBe(false);
      expect(rr.verdict).toBe("verification_failed");
    });

    it("does not flip when primary verdict was already verified_weak", () => {
      const rr = makeReviewerResult({
        verdict: "verified_weak",
        hands_off_violations: ["src/safety.ts"],
      });
      const outcome = applyReviewerSanityCheck(rr, ["src/cycle.ts"]);
      expect(outcome.dropped).toEqual(["src/safety.ts"]);
      expect(outcome.flipped).toBe(false);
      expect(rr.verdict).toBe("verified_weak");
    });

    it("is a no-op when response is null", () => {
      const rr: ReviewerResult = {
        verdict: "verification_failed",
        response: null,
        rawResponse: "",
        parseError: "bad json",
      };
      const outcome = applyReviewerSanityCheck(rr, ["src/cycle.ts"]);
      expect(outcome.dropped).toEqual([]);
      expect(outcome.flipped).toBe(false);
      expect(rr.verdict).toBe("verification_failed");
    });

    it("is a no-op when reviewer reported no hands_off_violations", () => {
      const rr = makeReviewerResult({ hands_off_violations: [] });
      const outcome = applyReviewerSanityCheck(rr, ["src/cycle.ts"]);
      expect(outcome.dropped).toEqual([]);
      expect(outcome.flipped).toBe(false);
    });
  });
});

describe("formatUnmergedBranchError", () => {
  it("interpolates a resolved absolute path into the git command", () => {
    // Relative path input — the message must resolve it to absolute.
    const project = makeProject({
      id: "myapp",
      path: "./some/relative/dir",
      branch: "bot/work",
    });
    const msg = formatUnmergedBranchError(project, "bot/work", 3);
    const expectedAbs = resolvePath("./some/relative/dir");

    expect(msg).toContain("bot/work has 3 unmerged commit(s)");
    expect(msg).toContain(`git -C ${expectedAbs} merge --no-ff bot/work`);
    // Relative form should NOT appear in the command (only the resolved one).
    expect(msg).not.toContain("git -C ./some/relative/dir merge");
  });

  it("names the exact project id in the auto_merge suggestion", () => {
    const project = makeProject({ id: "retrogaze", path: "/abs/p" });
    const msg = formatUnmergedBranchError(project, "bot/work", 1);
    expect(msg).toContain("auto_merge: true in projects.yaml for project retrogaze");
  });

  it("keeps absolute paths unchanged", () => {
    const absPath = resolvePath("/tmp/already-abs");
    const project = makeProject({ id: "p", path: absPath });
    const msg = formatUnmergedBranchError(project, "bot/work", 2);
    expect(msg).toContain(`git -C ${absPath} merge --no-ff bot/work`);
  });
});

// gs-177 / DESIGN.md §v5(a): the policy decision for what to do with the
// bot's branch when starting a new cycle. Pure function — no git calls,
// just the four-way truth table over (auto_merge ∈ {true,false}) ×
// (branch exists × has unmerged > 0).
describe("decideBotBranchHandling (gs-177)", () => {
  it("returns reset when the branch doesn't exist yet", () => {
    // Either auto_merge value — branch doesn't exist, no work to lose.
    const projAuto = makeProject({ auto_merge: true });
    const projManual = makeProject({ auto_merge: false });
    expect(decideBotBranchHandling(projAuto, false, 0).kind).toBe("reset");
    expect(decideBotBranchHandling(projManual, false, 0).kind).toBe("reset");
    // Even if `unmerged` is reported >0 (shouldn't happen but defensive),
    // a non-existent branch can't have unmerged work to protect.
    expect(decideBotBranchHandling(projAuto, false, 99).kind).toBe("reset");
  });

  it("returns reset when the branch exists but has no unmerged commits", () => {
    // Branch is at master HEAD (or behind) — nothing to protect.
    const projAuto = makeProject({ auto_merge: true });
    const projManual = makeProject({ auto_merge: false });
    expect(decideBotBranchHandling(projAuto, true, 0).kind).toBe("reset");
    expect(decideBotBranchHandling(projManual, true, 0).kind).toBe("reset");
  });

  it("returns merge-then-reset when auto_merge=true with unmerged work", () => {
    const project = makeProject({ auto_merge: true });
    const decision = decideBotBranchHandling(project, true, 3);
    expect(decision.kind).toBe("merge-then-reset");
    if (decision.kind === "merge-then-reset") {
      expect(decision.unmerged).toBe(3);
    }
  });

  it("returns accumulate when auto_merge=false with unmerged work (gs-177 NEW)", () => {
    // Pre-gs-177 this would have aborted the cycle. Post-gs-177 the
    // dispatcher leaves bot/work alone and lets the new cycle's work
    // pile on top.
    const project = makeProject({ auto_merge: false });
    const decision = decideBotBranchHandling(project, true, 1);
    expect(decision.kind).toBe("accumulate");
    if (decision.kind === "accumulate") {
      expect(decision.unmerged).toBe(1);
    }
  });

  it("preserves the unmerged count in both write decisions for logging", () => {
    // The dispatcher logs the count in both the merge-then-reset path
    // and the accumulate path; the helper's job is to surface it.
    const projAuto = makeProject({ auto_merge: true });
    const projManual = makeProject({ auto_merge: false });
    expect(decideBotBranchHandling(projAuto, true, 7)).toEqual({
      kind: "merge-then-reset",
      unmerged: 7,
    });
    expect(decideBotBranchHandling(projManual, true, 7)).toEqual({
      kind: "accumulate",
      unmerged: 7,
    });
  });

  it("treats undefined auto_merge as false (default per Hard Rule #4)", () => {
    // ProjectConfig may have auto_merge as a missing field for projects
    // declared in projects.yaml without the key. The helper must treat
    // a falsy auto_merge as the conservative default.
    const project = makeProject();
    delete (project as { auto_merge?: boolean }).auto_merge;
    const decision = decideBotBranchHandling(project, true, 2);
    expect(decision.kind).toBe("accumulate");
  });
});

describe("runSingleCycle — unknown project", () => {
  const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

  it("errors with ProjectNotFoundError-style message + exit code 1", async () => {
    const testDir = join(tmpdir(), "gs-cycle-nf-" + Date.now());
    try {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(
        join(testDir, "projects.yaml"),
        [
          "projects:",
          "  - id: alpha",
          "    path: .",
          "    priority: 1",
          "    engineer_command: \"echo hi\"",
          "    verification_command: \"echo ok\"",
          "    cycle_budget_minutes: 30",
          "    hands_off:",
          "      - CLAUDE.md",
          "dispatcher:",
          "  state_dir: ./state",
          "  fleet_state_file: ./fleet_state.json",
          "  stop_file: ./STOP",
          "  override_file: ./next_project.txt",
          "  picker: priority_x_staleness",
          "  max_cycles_per_project_per_session: 3",
          "  log_dir: ./logs",
          "  digest_dir: ./digests",
          "",
        ].join("\n"),
      );
      const proc = Bun.spawn(
        ["bun", "run", CLI_PATH, "cycle", "--project=nonesuch"],
        { stdout: "pipe", stderr: "pipe", cwd: testDir, env: { ...process.env } },
      );
      const stderr = await new Response(proc.stderr).text();
      await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
      expect(stderr).toContain("project 'nonesuch' not found");
      expect(stderr).toContain("Available: alpha");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// gs-168: regression guard against the gs-166 state-path inconsistency.
// Drives a full cycle on a fixture project where project.path !=
// getRootDir(), and asserts every path resolves to project.path (NOT
// the GeneralStaff repo root). If anyone reverts gs-166 — or if a new
// state-path lookup creeps in that uses getRootDir() instead of
// project.path — this test goes red.
describe("non-dogfood cycle end-to-end (gs-168)", () => {
  it("runs a full cycle against a fixture project at project.path != getRootDir()", async () => {
    // Skip if bun isn't usable in this environment (the helper is bun-only).
    if (typeof Bun === "undefined") return;

    const helperPath = join(
      import.meta.dir,
      "helpers",
      "verify_full_non_dogfood_cycle.ts",
    );
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
    const out = JSON.parse(lastLine);

    // (a) worktree creates at project.path/.bot-worktree
    expect(out.worktree_was_created).toBe(true);
    expect(out.worktree_existed_at_engineer_time).toBe(true);

    // (b) tasks.json is read from project.path
    expect(out.remaining_before_from_proj_path).toBe(1);
    expect(out.has_more_before_from_proj_path).toBe(true);

    // (c) verification runs (in the worktree under project.path)
    expect(out.verify_ran_in_worktree).toBe(true);
    expect(out.verification_outcome).toBe("passed");

    // (d) task-done detection sees the change in project.path's tasks.json
    expect(out.task_status_after_cycle).toBe("done");
    expect(out.diff_files_changed).toBeGreaterThan(0);
    expect(out.cycle_start_sha_changed).toBe(true);

    // overall: cycle completed verified
    expect(out.reviewer_called).toBe(true);
    expect(out.final_outcome).toBe("verified");
  }, 60_000);
});

describe("detectMalformedJsonFiles (gs-280)", () => {
  const FIXTURE = join(tmpdir(), `gs-malformed-json-${Date.now()}`);

  it("returns empty list when there are no .json files in the changed set", async () => {
    // Fixture that mostly exists to prove the filter works — *.md, *.ts
    // should all be skipped even if they contain JSON-looking text.
    const dir = join(FIXTURE, "no-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.md"), "{ this is not json }", "utf8");
    writeFileSync(join(dir, "src.ts"), "export const x = 1;", "utf8");
    expect(
      await detectMalformedJsonFiles(dir, ["notes.md", "src.ts"]),
    ).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty list when every .json file parses cleanly", async () => {
    const dir = join(FIXTURE, "valid-json");
    mkdirSync(join(dir, "state", "proj"), { recursive: true });
    writeFileSync(
      join(dir, "state", "proj", "tasks.json"),
      JSON.stringify([{ id: "t-001", status: "done" }]),
      "utf8",
    );
    writeFileSync(join(dir, "package.json"), '{"name":"x"}', "utf8");
    expect(
      await detectMalformedJsonFiles(dir, [
        "state/proj/tasks.json",
        "package.json",
      ]),
    ).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the specific file and error when a .json file is malformed", async () => {
    // The exact failure mode we hit 2026-04-20 on bookfinder-general:
    // missing `},` between sibling objects in a tasks.json list.
    const dir = join(FIXTURE, "malformed-json");
    mkdirSync(join(dir, "state", "proj"), { recursive: true });
    writeFileSync(
      join(dir, "state", "proj", "tasks.json"),
      '[\n  {\n    "id": "a",\n    "status": "done"\n  \n  {\n    "id": "b"\n  }\n]',
      "utf8",
    );
    const result = await detectMalformedJsonFiles(dir, [
      "state/proj/tasks.json",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("state/proj/tasks.json");
    expect(result[0].error.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips non-.json paths even when they would fail JSON.parse", async () => {
    const dir = join(FIXTURE, "skip-non-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "{{ not json }}", "utf8");
    writeFileSync(join(dir, "package.json"), '{"name":"ok"}', "utf8");
    // Only the .json file gets parsed; README.md is skipped.
    expect(
      await detectMalformedJsonFiles(dir, ["README.md", "package.json"]),
    ).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports missing .json files as malformed (file-not-found counts)", async () => {
    // Edge case: a file listed in changedFiles but not actually present
    // in the worktree. Either the diff was a deletion (we don't
    // distinguish) or something raced. Either way, safer to flag than
    // silently pass.
    const dir = join(FIXTURE, "missing-json");
    mkdirSync(dir, { recursive: true });
    const result = await detectMalformedJsonFiles(dir, ["gone.json"]);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("gone.json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty list when changedFiles is empty", async () => {
    expect(
      await detectMalformedJsonFiles(FIXTURE, []),
    ).toEqual([]);
  });

  it("truncates error messages to at most 500 characters", async () => {
    const dir = join(FIXTURE, "long-error");
    mkdirSync(dir, { recursive: true });
    // Large malformed JSON — actual JSON.parse error message won't
    // realistically exceed 500 chars, but the truncation guard lets
    // us bound the audit-log entry size if a future Node version
    // emits something longer.
    writeFileSync(
      join(dir, "big.json"),
      '{' + '"a":1,'.repeat(1000) + '}',  // bad trailing comma, will fail
      "utf8",
    );
    const result = await detectMalformedJsonFiles(dir, ["big.json"]);
    expect(result).toHaveLength(1);
    expect(result[0].error.length).toBeLessThanOrEqual(500);
    rmSync(dir, { recursive: true, force: true });
  });
});
