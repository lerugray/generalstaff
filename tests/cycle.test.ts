import { describe, expect, it } from "bun:test";
import { join } from "path";
import { $ } from "bun";
import { extractChangedFiles } from "../src/cycle";

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
});

describe("executeCycle", () => {
  it("runs verification and reviewer even when engineer exits non-zero", async () => {
    // Run in a subprocess so mock.module calls don't leak into other test files
    const helperPath = join(import.meta.dir, "helpers", "verify_nonzero_engineer_continues.ts");
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

    // Parse the JSON output for detailed assertions
    const lastLine = stdout.trim().split("\n").pop()!;
    const result = JSON.parse(lastLine);
    expect(result.engineer_exit_code).toBe(1);
    expect(result.verification_called).toBe(true);
    expect(result.reviewer_called).toBe(true);
    expect(result.final_outcome).toBe("verified");
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
